// Entry point pi loads for the omni extension.
//
//   pi -e /path/to/pppi/extensions/omni.ts        # one-off
//   ln -s .../pppi/extensions/omni.ts ~/.pi/agent/extensions/pppi-omni.ts
//
// See packages/omni/src/extension.ts for the implementation.

export { default } from "../packages/omni/src/extension.ts";
