/**
 * A folder owns only its immediate listing. Closing it invalidates in-flight
 * reads and releases its cache; repeated watcher events coalesce to one retry.
 * @param {(root:string, directory:string)=>Promise<{nodes:import('./types').TreeNode[], limited:boolean}>} read
 * @param {(state:{nodes:import('./types').TreeNode[],limited:boolean,loading:boolean,error:string})=>void} publish
 */
export function createDirectoryListing(read, publish) {
  let generation = 0;
  /** @type {{root:string,directory:string}|null} */
  let location = null;
  let loading = false,
    refreshPending = false;
  let state = {
    nodes: /** @type {import('./types').TreeNode[]} */ ([]),
    limited: false,
    loading: false,
    error: '',
  };
  const emit = (next) => {
    state = { ...state, ...next };
    publish(state);
  };
  const refresh = async () => {
    if (!location) return;
    if (loading) {
      refreshPending = true;
      return;
    }
    const ticket = generation,
      current = location;
    loading = true;
    emit({ loading: true, error: '' });
    try {
      const result = await read(current.root, current.directory);
      if (ticket === generation) emit({ nodes: result.nodes, limited: result.limited });
    } catch (error) {
      if (ticket === generation)
        emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (ticket === generation) {
        loading = false;
        emit({ loading: false });
        if (refreshPending) {
          refreshPending = false;
          void refresh();
        }
      }
    }
  };
  const close = () => {
    generation++;
    location = null;
    loading = false;
    refreshPending = false;
    emit({ nodes: [], limited: false, loading: false, error: '' });
  };
  return {
    open(root, directory) {
      close();
      location = { root, directory };
      return refresh();
    },
    refresh,
    close,
  };
}
