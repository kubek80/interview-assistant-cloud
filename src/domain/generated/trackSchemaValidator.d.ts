// Types for the generated standalone validator (see scripts/gen-track-validator.mjs).
export interface StandaloneValidate {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
}
declare const validate: StandaloneValidate;
export default validate;
