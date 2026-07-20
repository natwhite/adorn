/**
 * The documentation projection driven by **real `@` decorator syntax**.
 *
 * ## Why this file exists separately from `docs.test.ts`
 *
 * BUG-14 — enforcement saying `parameter 'sku'` while the generated document said `arg0` — survived
 * for a long time **because the projection's own tests populated the registry by hand**, through
 * `recordParameterConstraint` / `setParameterMetadata`. Those tests exercised a path no real decorator
 * ever took, so they could not observe that names never arrived, and they reported green throughout.
 *
 * The sibling file's hand-population is still good unit coverage of the registry read API and is kept.
 * It is simply no longer the *only* coverage: everything below decorates a class the way a user does
 * and asserts through the **rendered markdown**.
 *
 * ## The assertion style is the point
 *
 * The drift tests compare the field/parameter name in the **thrown violation message** against the
 * name in the **document**, and the expectation clause in the message against the expectation cell —
 * *to each other, never to a literal*. A literal on each side is exactly what let BUG-14 sit green:
 * both sides can be individually "correct" against a hardcoded string while disagreeing with each
 * other. Compared this way they cannot silently drift apart, whatever the toolchain does to names
 * (SMELL-1 minification included — under minification both sides degrade to `s` together, which is
 * the accepted trade, and these assertions still hold).
 *
 * ## `reflect-metadata` is loaded here on purpose
 *
 * It patches the realm's `Reflect`, which is what makes `design:type` / `design:paramtypes` available
 * and flips every decorated class in the file onto `__decorate`'s `Reflect.decorate` branch. Jest
 * gives each file its own realm and registry, so `docs.test.ts` genuinely runs without it — that split
 * is what distinguishes "the Type column is empty because the toolchain emitted nothing" (honest
 * degradation, asserted there) from "the Type column is empty because nothing reads it" (a defect).
 *
 * ## No `resetRegistry()` here, deliberately
 *
 * Field enforcement reads the registry on **every assignment**, so resetting it disarms an
 * already-installed field accessor — `ContractRegistry.resetRegistry` documents this. A contracted
 * class declared at module scope would therefore stop validating partway through the file. Every class
 * below is declared *inside* its test, and nothing resets.
 */

import 'reflect-metadata';

import {Contract} from '../Core/ContractInstaller';
import {GreaterThanEqual, StringMinLength} from '../ParameterDecorators/Constraints';
import {Enforce} from '../FieldDeocrators/Enforce';
import {documentClass, generateMarkdown, renderMarkdown} from './docs';

// ---------------------------------------------------------------------------
// Helpers — all of them read the *rendered document*, not the model
// ---------------------------------------------------------------------------

interface Row {
    readonly name: string;
    readonly type: string;
    readonly constraint: string;
    readonly expectation: string;
}

/** The message of the violation `act` throws. Fails the test if it throws nothing. */
function violationFrom(act: () => void): string {
    try {
        act();
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error('expected a contract violation, but nothing was thrown');
}

/**
 * Parse the rows of a rendered table back out of the markdown.
 *
 * Splits on **unescaped** pipes — the delimiters a markdown renderer would honour — so a row whose
 * prose contains an escaped `\|` is read as one cell, exactly as a reader would see it.
 */
function rowsUnder(markdown: string, heading: string): Row[] {
    const lines = markdown.split('\n');
    const start = lines.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);

    const rows: Row[] = [];
    for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index];
        if (/^#{2,3} /.test(line)) break;
        if (!/^\| `/.test(line)) continue;

        const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
        rows.push({name: cells[0], type: cells[1], constraint: cells[2], expectation: cells[3]});
    }
    return rows;
}

function fieldRows(markdown: string): Row[] {
    return rowsUnder(markdown, '### Fields');
}

/** Strip the backticks a table cell wraps an identifier in. */
function unquote(cell: string): string {
    const match = /^`([^`]*)`/.exec(cell);
    return match ? match[1] : cell;
}

/** `Value Error: <subject> expected <expectation> but received <value> instead`. */
function subjectOf(message: string): string {
    const match = /^Value Error: (.+?) expected /.exec(message);
    expect(match).not.toBeNull();
    return (match as RegExpExecArray)[1];
}

function expectationOf(message: string): string {
    const match = / expected (.+) but received /.exec(message);
    expect(match).not.toBeNull();
    return (match as RegExpExecArray)[1];
}

// ---------------------------------------------------------------------------
// The gap this task closes: a decorated field reaching the document at all
// ---------------------------------------------------------------------------

describe('a contracted field reaches the generated document (GAP-9)', () => {
    it('renders a field-only class as having contracts, not as having none', () => {
        // The regression this test exists for: the empty-case branch keyed on `methods.length`, so a
        // class carrying *only* field contracts rendered `_No contracts recorded._` — enforced at
        // runtime, reported as unenforced-and-absent. The silently-wrong artifact DEC-011 warns about,
        // emitted by the module meant to prevent it.
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;
        }

        const markdown = renderMarkdown([documentClass(Basket)]);

        expect(markdown).not.toContain('_No contracts recorded._');
        expect(markdown).toContain('### Fields');
        expect(fieldRows(markdown).map(row => unquote(row.name))).toEqual(['itemCount']);
    });

    it('carries the constraint identity and the descriptor\'s own expectation', () => {
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;
        }

        const [row] = fieldRows(renderMarkdown([documentClass(Basket)]));

        expect(unquote(row.constraint)).toBe('positive');
        expect(row.expectation).toBe('a positive number');
    });

    it('marks an enforced field as enforced', () => {
        // A field installs its validating accessor at decoration time, so unlike a method it needs no
        // `@Contract()` to become enforced — and the document must not warn as though it were pending.
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;
        }

        expect(documentClass(Basket).fields[0].installed).toBe(true);
        expect(renderMarkdown([documentClass(Basket)])).not.toContain('**Not enforced.**');
    });
});

// ---------------------------------------------------------------------------
// Drift — the BUG-14 assertion style, applied to fields
// ---------------------------------------------------------------------------

describe('the document and the enforcement cannot drift apart', () => {
    it('names the field identically in the document and in the violation it throws', () => {
        class Basket {
            @Enforce.positive()
            itemCount: number = 1;
        }

        const basket = new Basket();
        const message = violationFrom(() => {
            basket.itemCount = -5;
        });

        const [row] = fieldRows(renderMarkdown([documentClass(Basket)]));

        // Compared to EACH OTHER. Neither side is checked against a hardcoded `'itemCount'`, because
        // two literals is precisely the shape that let enforcement say `sku` and the document say
        // `arg0` while both suites passed.
        expect(subjectOf(message)).toBe(`Basket.${unquote(row.name)}`);
    });

    it('states the same expectation in the document as in the violation', () => {
        // Both sides come from the descriptor's own `describe()` (DEC-010), so this pins that the
        // document cannot describe a bound the enforcement does not check — Q-4, the worst failure
        // mode the "contracts as source of truth" goal introduces.
        class Basket {
            @Enforce.greaterThanEqual(10)
            capacity: number = 10;
        }

        const basket = new Basket();
        const message = violationFrom(() => {
            basket.capacity = 3;
        });

        const [row] = fieldRows(renderMarkdown([documentClass(Basket)]));

        expect(row.expectation).toBe(expectationOf(message));
    });

    it('agrees about a static field, which is recorded on the other key band', () => {
        // The two-band walk is `getFieldContractsForClass`'s job (DEC-018). If the projection walked
        // only the prototype this row would be missing entirely and nothing would throw to say so.
        class Widget {
            @Enforce.greaterThanEqual(1)
            static limit: number = 10;
        }

        const message = violationFrom(() => {
            Widget.limit = 0;
        });

        const [row] = fieldRows(renderMarkdown([documentClass(Widget)]));

        expect(subjectOf(message)).toBe(`Widget.${unquote(row.name)}`);
        expect(row.expectation).toBe(expectationOf(message));
        expect(row.name).toContain('_(static)_');
    });

    it('agrees about a parameter name too, through the same document', () => {
        // The method half of the same guarantee (BUG-14), asserted here through the *rendered*
        // document rather than the model, so the projection's own formatting is in the loop.
        @Contract()
        class Order {
            place(@StringMinLength(3) sku: string, @GreaterThanEqual(1) quantity: number) {
                return `${sku}x${quantity}`;
            }
        }

        const order = new Order();
        const message = violationFrom(() => {
            order.place('ab', 5);
        });

        const markdown = renderMarkdown([documentClass(Order)]);
        const [row] = rowsUnder(markdown, '### Order.place(sku, quantity)');

        // `Value Error: Order.place(sku, quantity) parameter 'sku' expected ...`
        expect(subjectOf(message)).toContain(`parameter '${unquote(row.name)}'`);
        expect(row.expectation).toBe(expectationOf(message));
    });
});

// ---------------------------------------------------------------------------
// Both bands in one document
// ---------------------------------------------------------------------------

describe('methods and fields in one document', () => {
    it('renders both bands for a class that has both', () => {
        @Contract()
        class Shipment {
            @Enforce.notEmpty()
            reference: string = 'INIT';

            @Enforce.greaterThanEqual(1)
            static maxParcels: number = 50;

            quote(@StringMinLength(3) destination: string, @GreaterThanEqual(1) weight: number) {
                return `${destination}:${weight}`;
            }
        }

        const markdown = renderMarkdown([documentClass(Shipment)]);

        expect(markdown).toContain('### Shipment.quote(destination, weight)');
        expect(markdown).toContain('| Parameter | Type | Constraint | Expectation |');
        expect(markdown).toContain('### Fields');
        expect(markdown).toContain('| Field | Type | Constraint | Expectation |');

        // Instance fields before statics, matching how methods are ordered.
        expect(fieldRows(markdown).map(row => unquote(row.name))).toEqual(['reference', 'maxParcels']);
    });

    it('fills the field Type column from design:type', () => {
        class Shipment {
            @Enforce.notEmpty()
            reference: string = 'INIT';

            @Enforce.positive()
            parcels: number = 1;
        }

        const rows = fieldRows(renderMarkdown([documentClass(Shipment)]));
        const typeByName: {[name: string]: string} = {};
        rows.forEach(row => {
            typeByName[unquote(row.name)] = unquote(row.type);
        });

        // Keyed by name rather than by position: fields are sorted alphabetically (as methods are),
        // so asserting declaration order here would pin the sort rather than the type capture.
        expect(typeByName).toEqual({parcels: 'Number', reference: 'String'});
    });

    it('generateMarkdown picks up a class registered by @Contract()', () => {
        @Contract()
        class Invoice {
            @Enforce.positive()
            total: number = 1;

            issue(@StringMinLength(3) reference: string) {
                return reference;
            }
        }
        void Invoice;

        const markdown = generateMarkdown();

        expect(markdown).toContain('## Invoice');
        expect(markdown).toContain('### Invoice.issue(reference)');
        expect(markdown).toContain('### Fields');
    });

    it('a field-only class is NOT enumerated without @Contract() — a registry-level gap', () => {
        // Documented rather than worked around, because it is not this module's to fix. Field
        // decorators install enforcement but never call `registerContractedClass`, so a class whose
        // *only* contracts are fields is enforced yet invisible to `documentContracts()`. That is the
        // exact asymmetry DEC-016 settled for methods ("installation implies enumeration") left
        // unresolved for fields. `documentClass` on the constructor directly still reports it in full.
        class Untracked {
            @Enforce.positive()
            amount: number = 1;
        }

        expect(generateMarkdown()).not.toContain('## Untracked');
        expect(documentClass(Untracked).fields.map(field => field.name)).toEqual(['amount']);
    });
});
