import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:track-schema-validator';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/**
 * Compiles schema/track.schema.json to a standalone validator at build time.
 * Ajv's runtime compiler uses `new Function`, which the CSP (SEC-1) forbids, so the
 * browser only ever runs pre-generated code. If the schema file does not exist yet,
 * the module exports `null` and the hand-rolled validator is used on its own.
 */
export function trackSchemaValidator(root: string): Plugin {
  const schemaPath = resolve(root, 'schema/track.schema.json');
  const require = createRequire(import.meta.url);

  return {
    name: 'track-schema-validator',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      this.addWatchFile(schemaPath);
      if (!existsSync(schemaPath)) return 'export default null;';
      try {
        const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
        const is2020 = typeof schema.$schema === 'string' && schema.$schema.includes('2020-12');
        const AjvClass = is2020 ? require('ajv/dist/2020').default : require('ajv').default;
        const standaloneCode = require('ajv/dist/standalone').default;
        const ajv = new AjvClass({
          code: { source: true, esm: true },
          strict: false,
          allErrors: true,
          validateFormats: false,
        });
        const validate = ajv.compile(schema);
        let code: string = standaloneCode(ajv, validate);
        // Standalone output may still require() runtime helpers; turn those into imports that
        // work whichever way the bundler interops the CommonJS module.
        const imports: string[] = [];
        code = code.replace(/require\("([^"]+)"\)/g, (_m, spec: string) => {
          const i = imports.length;
          imports.push(`import * as __ns${i} from ${JSON.stringify(spec)};\nconst __ajvRuntime${i} = { default: __pick(__ns${i}) };`);
          return `__ajvRuntime${i}`;
        });
        const pick = 'const __pick = (m) => { const d = m.default ?? m; return d && typeof d === "object" && "default" in d ? d.default : d; };';
        return (imports.length ? pick + '\n' + imports.join('\n') + '\n' : '') + code;
      } catch (err) {
        this.warn(`Could not compile schema/track.schema.json: ${(err as Error).message}`);
        return 'export default null;';
      }
    },
  };
}
