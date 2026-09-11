#!/usr/bin/env node
/**
 * `dsh-rescue` 鈥?the entry point a person runs when the harness will not start.
 *
 * It imports nothing from the harness at module scope: every harness package is
 * loaded at runtime from a deployment plane this file finds first. That is the
 * whole point 鈥?a broken profile composition, a broken bundle, or a broken
 * plugin cannot prevent this command from running.
 *
 * Commands:
 *   doctor     diagnose without booting or calling a model
 *   verify     boot the real profile once and report whether it came up
 *   repair     boot a minimal creation-mode agent and repair the harness
 *   supervise  run the real profile; if it fails, capture and repair automatically
 *   shim       install a short launcher next to the harness home
 * @module @dsh-external/dsh-rescue/cli
 */
export {};
