import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// The screen footage is the heavy input; keep concurrency modest so a laptop render is stable.
Config.setConcurrency(4);
