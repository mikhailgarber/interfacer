/**
 * The person in the session, reached in prose.
 *
 * A run is one continuous session with a human in it, and this is how it
 * reaches them — in the interview, and again during generation when the model
 * needs a live value to proceed. A question goes out as text and the answer
 * comes back as text.
 *
 * Deliberately not the DSL's `Resolver`, which answers a pause in a *running*
 * capability. A pause has three kinds and three answer types because a flow
 * stopped mid-step needs a value of a known shape before it can continue, and
 * the engine rejects an answer that does not match the kind it asked for. A
 * discovery question has no such shape: the answer is whatever the person says,
 * and turning that into a contract answer is the model's job rather than the
 * channel's. Widening the pause response to carry arbitrary text would loosen a
 * validation that exists to catch a caller's mistake, for a case no flow has.
 */
export interface Question {
  /** `confirm` puts a proposal for acceptance; `open` asks in the open. */
  readonly kind: 'open' | 'confirm';
  readonly text: string;
  /**
   * The answer is a credential, so a channel that echoes must not echo it.
   *
   * Set where the question asks for the value of a `secret()` input — which
   * Interfacer knows and the model does not, since it names the input in `for`
   * and the loop is what resolves that to a declaration. A live value for a
   * secret is a real credential, and the redaction that applies to it at replay
   * applies while it is being typed: the run record already keeps it out, and
   * this keeps it off the screen.
   */
  readonly secret?: boolean;
}

export type Ask = (question: Question) => Promise<string>;

/**
 * What counts as accepting a proposal. Anything else is not a confirmation.
 *
 * A proposal is answered by acceptance rather than by content: an amended
 * answer ("no, and cdn.mybank.net too") records nothing, because the value that
 * would go in is the one that was put — so the model asks again with the
 * amendment instead of Interfacer guessing at what the person meant.
 */
export function accepted(answer: string): boolean {
  return /^(y|yes|ok|sure|agreed?)\b/i.test(answer.trim());
}
