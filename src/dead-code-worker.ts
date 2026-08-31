import { parentPort, workerData } from "node:worker_threads";
import type { ProjectInfo } from "./types.js";
import { analyzeDeadCode, type DeadCodeFinding } from "./utils/dead-code.js";

interface DeadCodeWorkerData {
  rootDirectory: string;
  files: string[];
  project: ProjectInfo;
}

interface DeadCodeWorkerSuccess {
  ok: true;
  findings: DeadCodeFinding[];
}

interface DeadCodeWorkerFailure {
  ok: false;
  error: {
    name?: string;
    message: string;
    stack?: string;
  };
}

const serializeError = (error: unknown): DeadCodeWorkerFailure["error"] => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
};

try {
  const data = workerData as DeadCodeWorkerData;
  const message: DeadCodeWorkerSuccess = {
    ok: true,
    findings: analyzeDeadCode(data.rootDirectory, data.files, data.project),
  };
  parentPort?.postMessage(message);
} catch (error) {
  const message: DeadCodeWorkerFailure = {
    ok: false,
    error: serializeError(error),
  };
  parentPort?.postMessage(message);
}
