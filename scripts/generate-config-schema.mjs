import fs from "node:fs";
import path from "node:path";

const schemaPath = path.resolve("schema/config.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Wrote ${schemaPath}`);
