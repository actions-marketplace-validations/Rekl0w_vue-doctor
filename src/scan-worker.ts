import { parentPort, workerData } from "node:worker_threads";
import { scanFile } from "./scanner.js";
import type { ProjectInfo, VueDoctorConfig } from "./types.js";

interface ScanWorkerData {
  files: string[];
  rootDirectory: string;
  config: VueDoctorConfig;
  project: ProjectInfo;
}

const data = workerData as ScanWorkerData;
const diagnostics = data.files.flatMap((filePath) =>
  scanFile(filePath, data.rootDirectory, data.config, data.project),
);

parentPort?.postMessage({ diagnostics });
