/**
 * What the application itself says about what it is, and what it let happen.
 *
 * Two declarations are proposed from the pages rather than asked for in the
 * interview, because neither is knowable before somebody has driven the
 * application: `vendor` / `appVersion` for the variant stamp — a product name in
 * a title bar, a build string in a footer — and a revision to `securityEffect`,
 * from what the screens gave up. Both are proposals; the person confirms them,
 * on the same terms as the allowlist. A model that settles either for itself is
 * authoring its own constraint.
 *
 * The session is re-opened and the flow re-run so the model is looking at the
 * screens again rather than at a recollection of them. The steps are performed,
 * never appended: the flow is finished, and looking at it must not grow it.
 */
import {
  addUsage,
  openExecution,
  ZERO_SPEND,
  type FieldSet,
  type Flow,
  type RunOptions,
  type SecurityEffect,
  type Spend,
} from '@interfacer/dsl';

import type { ContractBrief, Decide, Exchange, ToolDefinition } from '../agent/decide.js';
import { rerunFlow } from './rerun.js';

const STAMP: ToolDefinition = {
  name: 'stamp',
  description:
    'Name the vendor and the application version, if the pages actually reveal them. Omit either where they do not: a fabricated version reads as fact, which is worse than a missing one.',
  inputSchema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Who makes this application.' },
      appVersion: { type: 'string', description: 'The build or release it is running.' },
    },
    required: [],
    additionalProperties: false,
  },
};

const SECURITY: ToolDefinition = {
  name: 'securityEffect',
  description:
    'Say whether the task changes who can access the account afterwards, from what the screens showed — a password field being written rather than used to sign in, labels like MFA, signer, role or entitlement, routes such as /security, confirmation text along the lines of "your password has been changed".',
  inputSchema: {
    type: 'object',
    properties: {
      value: { enum: ['none', 'authority-change', 'control-override'] },
      why: { type: 'string', description: 'What on the page says so, in one line.' },
    },
    required: ['value'],
    additionalProperties: false,
  },
};

export interface Proposals {
  readonly vendor?: string;
  readonly appVersion?: string;
  readonly securityEffect?: SecurityEffect;
  readonly why?: string;
  readonly spend: Spend;
}

export interface InspectOptions extends RunOptions {
  readonly decide: Decide;
  readonly live: Record<string, unknown>;
}

/** Walk the finished flow once more and ask the model what it saw. */
export async function inspect(
  flow: Flow<FieldSet, unknown>,
  options: InspectOptions,
): Promise<Proposals> {
  const execution = await openExecution(flow, options.live as never, {
    ...options,
    phase: 'discovery',
    headless: options.headless ?? false,
  });

  let spend: Spend = ZERO_SPEND;

  try {
    await rerunFlow(execution, flow);

    const brief: ContractBrief = {
      capability: flow.id,
      inputNames: Object.keys(flow.input),
      outcomes: [],
      allowlist: [...flow.declaredAllowlist],
    };

    const transcript: Exchange[] = [];
    const turn = await options.decide(
      {
        task: 'You have just driven this task end to end. Say what application this is, and whether the task changes who can access the account afterwards. Answer from what the screens showed, and leave out anything they did not.',
        contract: brief,
        observation: await execution.observe(),
        transcript,
        budget: { capUsd: Number.POSITIVE_INFINITY, spentUsd: 0 },
      },
      [STAMP, SECURITY],
    );

    spend = addUsage(spend, turn.usage);
    // The inspection pass spends on the model as well, and said nothing.
    for (const call of turn.calls.length === 0 ? [undefined] : turn.calls) {
      execution.record({
        kind: 'model.turn',
        reason: turn.text,
        tool: call?.name ?? 'none',
        usage: turn.usage,
        costUsd: 0,
      });
    }

    let vendor: string | undefined;
    let appVersion: string | undefined;
    let securityEffect: SecurityEffect | undefined;
    let why: string | undefined;

    for (const call of turn.calls) {
      if (call.name === 'stamp') {
        vendor = text(call.input.vendor);
        appVersion = text(call.input.appVersion);
        continue;
      }
      if (call.name === 'securityEffect') {
        const value = call.input.value;
        if (value === 'none' || value === 'authority-change' || value === 'control-override') {
          securityEffect = value;
          why = text(call.input.why);
        }
      }
    }

    return {
      ...(vendor === undefined ? {} : { vendor }),
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(securityEffect === undefined ? {} : { securityEffect }),
      ...(why === undefined ? {} : { why }),
      spend,
    };
  } finally {
    execution.finishedWith({ ending: 'success' });
    await execution.close();
  }
}

/** A field nobody knows is absent rather than guessed. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
