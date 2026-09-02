// Entry point pi loads for the omni extension.
//
//   pi -e /path/to/sspi/extensions/omni.ts        # one-off
//   ln -s .../sspi/extensions/omni.ts ~/.pi/agent/extensions/sspi-omni.ts
//
// See packages/omni/src/extension.ts for the implementation.

export { default } from "../packages/omni/src/extension.ts";
