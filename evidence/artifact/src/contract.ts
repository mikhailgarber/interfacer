/**
 * The capability's contract, declared once as values.
 *
 * The compiler checks the master function against `Input`; the CLI parser, the
 * MCP tool schema and the generated documentation read these same declarations
 * at run time. There is no second representation to keep in step.
 */
import { fields, secret, text } from '@interfacer/dsl';
import type { Infer } from '@interfacer/dsl';

export const inputFields = fields({
  url: text({ description: 'entry point' }),
  accountNumber: text({
    description: 'The customer account number to look up, e.g. ACC-1001.',
  }),
  username: text({
    description:
      'Username to sign in to the Meridian Bank back-office app with; teller1.',
  }),
  password: secret({ description: 'Password for the sign-in user.' }),
});

export type Input = Infer<typeof inputFields>;

/** What this capability does. Published so a caller sees it before invoking. */
export const effects = {
  mutates: 'read',
  reversible: 'yes',
  securityEffect: 'none',
  scope: 'single',
  external: 'none',
  financial: 'none',
  idempotent: true,
  dataClasses: ['PII'],
} as const;
