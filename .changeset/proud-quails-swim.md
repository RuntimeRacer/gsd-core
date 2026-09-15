---
type: Added
pr: 4746
---
**Zoo Code (the community continuation of the archived Roo Code) is a supported runtime** — install with --zoo. Every GSD agent becomes a Zoo custom mode (entries in .roomodes / the extension's global custom_modes.yaml, merged without touching user modes) and every GSD command becomes a flat slash command under .roo/commands/ (gsd-*.md, discovered as /gsd-* commands). Subagents dispatch via Zoo's new_task mode system; there is no hooks surface on Zoo today. The flags --roo, --roo-code, --roo-cline, and --zoo-code are aliases of --zoo, so migrating Roo Code users keep a working flag. The global config home is ~/.roo with --config-dir > ZOO_CONFIG_DIR > ROO_CONFIG_DIR precedence (GSD installer convention). Conversion logic is ported from the retired harmony-ai-solutions/gsd-roo-code fork, including its regression fixes (no-trailing-slash ~/.claude rewrites), now descriptor-driven behind a new zoo-modes install surface analogous to cline-rules. (#4746)
