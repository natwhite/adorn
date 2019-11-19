import {ParameterDecoratorFactory, ParamObject} from '../Core/ParameterDecoratorFactory';

const simpleDecor = ParameterDecoratorFactory.CreateSimpleDecorator;

// TODO : Write the decorator generator to by polymorphic across parameter / method / class decorators

const Positive = () => simpleDecor((params: ParamObject<number>) => {
    if (params.value < 0)
        throw new Error(`Value Error: ${params.signature} expected a positive number but received ${params.value} instead`);
});

const LessThanEqual = (constraint) => simpleDecor((params: ParamObject<number>) => {
    if (params.value > constraint)
        throw new Error(`Value Error: ${params.signature} expected a number less than or equal to ${constraint} but received ${params.value} instead`);
});

const GreaterThanEqual = (constraint) => simpleDecor((params: ParamObject<number>) => {
    if (params.value < constraint)
        throw new Error(`Value Error: ${params.signature} expected a number greater than or equal to ${constraint} but received ${params.value} instead`);
});

const StringMinLength = (constraint) => simpleDecor((params: ParamObject<string>) => {
    if (params.value.length < constraint)
        throw new Error(`Value Error: ${params.signature} expected a string of length greater than ${constraint} but received '${params.value}' instead`);
});

export {
    Positive,
    LessThanEqual,
    GreaterThanEqual,
    StringMinLength,
};
