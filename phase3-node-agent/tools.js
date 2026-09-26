// Tools the agent is allowed to call. Each tool has a JSON schema (so the
// model knows how to call it) and a real JS function (what actually runs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const toolDefs = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders inside a directory on the local machine.",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Absolute or relative path to a directory." },
        },
        required: ["dir_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the text content of a file on the local machine.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute or relative path to a file." },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current local date and time.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export const toolImpls = {
  list_files: ({ dir_path }) => {
    try {
      return readdirSync(dir_path).map((name) => {
        const full = join(dir_path, name);
        const isDir = statSync(full).isDirectory();
        return `${isDir ? "[dir] " : "[file]"} ${name}`;
      });
    } catch (err) {
      return { error: err.message };
    }
  },
  read_file: ({ file_path }) => {
    try {
      return readFileSync(file_path, "utf-8").slice(0, 4000); // cap so we don't blow the context window
    } catch (err) {
      return { error: err.message };
    }
  },
  get_current_time: () => new Date().toString(),
};
