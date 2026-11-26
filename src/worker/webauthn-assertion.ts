import type { Env } from "./types";

export async function claimWebAuthnAssertion(
  env: Env,
  credentialId: string,
  expectedVersion: number,
  newCounter: number,
): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE webauthn_credentials
    SET counter = MAX(counter, ?), assertion_version = assertion_version + 1,
      last_used_at = CURRENT_TIMESTAMP
    WHERE id = ? AND assertion_version = ?`)
    .bind(newCounter, credentialId, expectedVersion).run();
  return result.meta.changes === 1;
}
