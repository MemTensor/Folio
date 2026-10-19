// Keep recovery-relevant IDs and uncertain submissions. Only completed local
// navigation journals are retired; source files and remote objects are untouched.
function retainPublications(publications) {
  const completed = Object.values(publications)
    .filter((p) => ['retired', 'withdrawn'].includes(p.state))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of completed.slice(200)) delete publications[entry.id];
  for (const entry of Object.values(publications)) {
    for (const key of ['response', 'cloudStatus']) {
      const value = entry[key];
      if (!value || typeof value !== 'object') continue;
      const rows = value.data?.file_detail_list || value.data;
      entry[key] = {
        code:
          typeof value.code === 'number' || typeof value.code === 'string'
            ? String(value.code).slice(0, 40)
            : undefined,
        data: {
          file_detail_list: (Array.isArray(rows) ? rows : [])
            .filter((row) => row && typeof row === 'object')
            .slice(0, 100)
            .map((row) => ({
              id: String(row.id || row.file_id || row.fileId || '').slice(0, 300),
              status: String(row.status || '').slice(0, 80),
            })),
        },
      };
    }
    if (Array.isArray(entry.resolutions)) entry.resolutions = entry.resolutions.slice(-20);
  }
}
module.exports = { retainPublications };
