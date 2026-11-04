import path from 'path';
import { importWorkbook } from './import-workbook.js';
import { getMetricsDbPath } from './db.js';

/**
 * Writes a Ministry Metrics workbook into the database.
 *
 *   node dist/server/ministry-metrics/cli-import.js <file.xlsx> [--by "Name"]
 *
 * Run verify-import against the same file first; this command writes.
 */
async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: cli-import <file.xlsx> [--by "Name"]');
    process.exit(1);
  }

  const byIndex = args.indexOf('--by');
  const importedBy = byIndex >= 0 ? args[byIndex + 1] : undefined;

  console.log(`Importing ${path.basename(file)}`);
  console.log(`Database  ${getMetricsDbPath()}`);

  const s = await importWorkbook(path.resolve(file), { importedBy });

  console.log('\nDone.');
  console.log(`  weeks inserted     ${s.weeksInserted}`);
  console.log(`  weeks updated      ${s.weeksUpdated}`);
  console.log(`  services written   ${s.servicesWritten}`);
  console.log(`  metrics written    ${s.metricsWritten}`);
  console.log(`  giving rows        ${s.givingWritten}`);
  console.log(`  highlights linked  ${s.highlightsAttached}`);
  console.log(`  issues recorded    ${s.issuesRecorded}`);
  if (s.noServiceWeeks.length) {
    console.log(`  no-service weeks   ${s.noServiceWeeks.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
