import { FILE_SORT_OPTIONS } from './sidebar-order.mjs';

/** @typedef {import('./sidebar-order.mjs').FileSortMode} FileSortMode */
/** @typedef {{path:string,name:string,relativePath:string,modifiedAt:number,size:number}} ProjectDocument */
/** @typedef {{documents:ProjectDocument[],limited:boolean,scanned:number,fromCache:boolean,updatedAt:number,excluded:boolean,total:number,hasMore:boolean,offset:number}} ProjectDocumentsResult */
/** @typedef {{query?:string,includeArchives?:boolean,refresh?:boolean,sort?:FileSortMode,limit?:number,offset?:number}} DocumentOptions */

export const DOCUMENT_SORT_KEY = 'folio-document-sort';
/** @param {{getItem:(key:string)=>string|null}} storage @returns {FileSortMode} */
export function loadDocumentSort(storage) {
  try {
    const saved = storage.getItem(DOCUMENT_SORT_KEY);
    return FILE_SORT_OPTIONS.find((option) => option.value === saved)?.value || 'modified-desc';
  } catch {
    return 'modified-desc';
  }
}

/** @param {{setItem:(key:string,value:string)=>void}} storage @param {FileSortMode} value */
export function saveDocumentSort(storage, value) {
  try {
    storage.setItem(
      DOCUMENT_SORT_KEY,
      FILE_SORT_OPTIONS.find((option) => option.value === value)?.value || 'modified-desc',
    );
    return true;
  } catch {
    return false;
  }
}

/** @returns {ProjectDocumentsResult & {loading:boolean,loadingMore:boolean,error:string,cancelled:boolean}} */
export function emptyDocumentListing() {
  return {
    documents: [],
    limited: false,
    scanned: 0,
    fromCache: false,
    updatedAt: 0,
    excluded: false,
    total: 0,
    hasMore: false,
    offset: 0,
    loading: false,
    loadingMore: false,
    error: '',
    cancelled: false,
  };
}

/**
 * Only the visible project owns a request. Project/query changes invalidate both
 * successes and failures, and cancellation completes before a replacement starts.
 * Watcher bursts coalesce into one pending refresh rather than spawning scans.
 * @param {(root:string,options:DocumentOptions)=>Promise<ProjectDocumentsResult>} read
 * @param {(root:string)=>Promise<unknown>} cancelRequest
 * @param {(state:ReturnType<typeof emptyDocumentListing>)=>void} publish
 */
export function createProjectDocumentListing(read, cancelRequest, publish) {
  let generation = 0;
  /** @type {{root:string,options:DocumentOptions}|null} */
  let location = null;
  let loading = false,
    pending = false,
    pendingForce = false,
    nextOffset = 0;
  let cancellation = Promise.resolve();
  let state = emptyDocumentListing();
  const emit = (patch) => {
    state = { ...state, ...patch };
    publish(state);
  };
  const invalidate = () => {
    generation++;
    if (location) {
      const root = location.root;
      cancellation = cancellation
        .then(() => cancelRequest(root))
        .then(
          () => {},
          () => {},
        );
    }
    loading = false;
    pending = false;
    pendingForce = false;
  };
  const request = async (force, append) => {
    if (!location) return;
    if (!force && state.cancelled) return;
    if (loading) {
      if (append) return;
      pending = true;
      pendingForce ||= force;
      return;
    }
    if (append && !state.hasMore) return;
    const ticket = generation,
      current = location,
      limit = current.options.limit || 100,
      pages = append || force ? 1 : Math.max(1, Math.ceil(nextOffset / limit));
    loading = true;
    emit({ loading: true, loadingMore: append, error: '', cancelled: false });
    try {
      await cancellation;
      if (ticket !== generation) return;
      let offset = append ? nextOffset : 0;
      /** @type {ProjectDocument[]} */
      const documents = [];
      /** @type {ProjectDocumentsResult|undefined} */
      let result;
      for (let page = 0; page < pages; page++) {
        result = await read(current.root, {
          ...current.options,
          limit,
          offset,
          refresh: force && page === 0,
        });
        if (ticket !== generation) return;
        documents.push(...result.documents);
        offset = result.offset + result.documents.length;
        if (!result.hasMore || !result.documents.length) break;
      }
      if (result && ticket === generation) {
        const entries = [...(append ? state.documents : []), ...documents];
        const unique = [...new Map(entries.map((document) => [document.path, document])).values()];
        nextOffset = offset;
        if (append && state.updatedAt !== result.updatedAt) pending = true;
        emit({ ...result, documents: unique });
      }
    } catch (error) {
      if (ticket === generation)
        emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (ticket === generation) {
        loading = false;
        emit({ loading: false, loadingMore: false });
        if (pending) {
          const refreshFromDisk = pendingForce;
          pending = false;
          pendingForce = false;
          void request(refreshFromDisk, false);
        }
      }
    }
  };
  const close = () => {
    invalidate();
    location = null;
    nextOffset = 0;
    state = emptyDocumentListing();
    publish(state);
  };
  return {
    /** @param {string} root @param {DocumentOptions} options */
    open(root, options = {}) {
      close();
      if (!root) return Promise.resolve();
      location = { root, options: { ...options } };
      return request(false, false);
    },
    refresh(force = true) {
      return request(force, false);
    },
    loadMore() {
      return request(false, true);
    },
    cancel() {
      invalidate();
      emit({ loading: false, loadingMore: false, cancelled: true });
    },
    close,
  };
}
