import fs from "fs-extra";
import path from "path";
import pino from "pino";
import { config } from "./config.js";

await fs.ensureDir(config.directories.logs);

const transport = pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
      },
    },
    {
      target: "pino/file",
      options: {
        destination: path.join(config.directories.logs, "app.log"),
        mkdir: true,
      },
    },
  ],
});

export const logger = pino({ level: "info" }, transport);
