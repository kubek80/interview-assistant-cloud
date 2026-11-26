/// <reference types="vite/client" />

declare module 'virtual:track-schema-validator' {
  interface StandaloneValidate {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  }
  const validate: StandaloneValidate | null;
  export default validate;
}
