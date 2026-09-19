import test from "node:test";

import assert from "node:assert/strict";

import type { SandboxConfig } from "../src/config.ts";

import { isNetworkUnrestricted } from "../src/policy.ts";

test("isNetworkUnrestricted is true only when network.disabled is explicitly true", () => {
  const base = { filesystem: {} } as SandboxConfig;
  assert.equal(isNetworkUnrestricted(base), false);
  assert.equal(
    isNetworkUnrestricted({
      ...base,
      network: { allowedDomains: [], deniedDomains: [], disabled: false },
    }),
    false,
  );
  assert.equal(
    isNetworkUnrestricted({ ...base, network: { allowedDomains: [], deniedDomains: [] } }),
    false,
  );
  assert.equal(
    isNetworkUnrestricted({
      ...base,
      network: { allowedDomains: [], deniedDomains: [], disabled: true },
    }),
    true,
  );
});
