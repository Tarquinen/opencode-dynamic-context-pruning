// OpenCode V2 plugin entrypoint for opencode-dcp.
//
// The implementation lives in ./lib/v2, which maps every V1 hook onto the V2
// plugin API (see the mapping below). This file is intentionally thin: it only
// declares the plugin identity and wires `setup`.
//
// V1 -> V2 hook mapping:
//   experimental.chat.system.transform  -> ctx.session.hook("context") editing event.system
//   experimental.chat.messages.transform -> ctx.session.hook("context") editing event.messages
//                                          (also registered for "compaction" so native
//                                          checkpoint summaries keep DCP transforms)
//   experimental.text.complete          -> no direct equivalent; hallucination stripping
//                                          runs inside the context/compaction hooks instead
//   command.execute.before              -> ctx.command.transform (editor.add) executors;
//                                          manual compression submits via ctx.session.prompt
//   event (message.part.updated)        -> not needed: compression timing is measured around
//                                          the tool executor in the ctx.tool.transform path
//   tool.compress                       -> ctx.tool.transform (editor.add) with permission
//                                          gating resolved per session at execute time
//   config                              -> replaced by per-request permission resolution
//                                          against agent/session permission rules (V2 has
//                                          no merged "config" hook)

import { Plugin } from "@opencode/plugin"
import { setup } from "./lib/v2"

const plugin = Plugin.define({
    id: "opencode-dcp",
    setup,
})

export default plugin
