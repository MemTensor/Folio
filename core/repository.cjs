// A build-time identity shared by publishing and updating. No renderer or
// environment override: credentials must only be sent to this GitHub repository.
const { repository } = require('../package.json');
const match =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\.git$/.exec(
    repository?.url || '',
  );
if (!match) throw Error('Invalid GitHub repository in package.json.');
const REPOSITORY = match[1];
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases`;
module.exports = { REPOSITORY, RELEASE_PAGE };
