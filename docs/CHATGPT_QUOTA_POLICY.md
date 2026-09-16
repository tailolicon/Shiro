# ChatGPT quota policy — Sol only

Owner policy effective 2026-09-11:

- Shiro must never consume GPT-6 Pro / Astra / Pro-model quota for autonomous work, browser workers, fleets, or image-generation coordination.
- Maximum allowed ChatGPT model is **GPT-5.6 Sol**.
- Maximum allowed Sol reasoning level is **xhigh / Extra High**.
- Browser/fleet submissions explicitly select `GPT-5.6 Sol` and `xhigh`; they must not inherit whatever model a tab used previously.
- Launcher and bridge defaults are Sol. Bridge configuration rejects GPT-6/Astra/Pro-like model identifiers on Shiro runtime routes.
- Image generation may use GPT Image, but the coordinating ChatGPT session must remain Sol-only. Image output itself is not evidence that a Pro model was used.
- A future change to this policy must be an explicit owner decision and code/config change; workers must not relax it to finish a task.

Relevant enforcement lives in `bridge/src/index.js`, `bridge/src/fleet-manager.js`, `bridge/src/chatgpt-relay.js`, the launch scripts, and their regression tests.
