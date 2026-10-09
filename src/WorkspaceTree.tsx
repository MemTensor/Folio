import { useEffect, useMemo, useState } from 'react';
import { CaretDown, CaretRight, FileText, Folder } from '@phosphor-icons/react';
import { bridge } from './bridge';
import { t, getLocale } from './i18n';
import { createDirectoryListing } from './directory-listing.mjs';
import { sortFileTree, type FileSortMode } from './sidebar-order.mjs';
import type { TreeNode } from './types';

interface Props {
  root: string;
  nodes: TreeNode[];
  sort: FileSortMode;
  refresh: number;
  active: string;
  onOpen: (path: string) => void;
  onMenu: (path: string) => void;
  depth?: number;
}

export function WorkspaceTree(props: Props) {
  const { nodes, sort, active, onOpen, onMenu, depth = 0 } = props;
  const locale = getLocale();
  const sorted = useMemo(() => sortFileTree(nodes, sort, locale), [nodes, sort, locale]);
  return (
    <>
      {sorted.map((node) =>
        node.kind === 'folder' ? (
          <WorkspaceFolder key={node.path} {...props} node={node} />
        ) : (
          <button
            key={node.path}
            className={'tree-file ' + (active === node.path ? 'selected' : '')}
            style={{ paddingLeft: 28 + depth * 14 }}
            onClick={() => onOpen(node.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(node.path);
            }}
          >
            <FileText size={16} />
            <span>{node.name.replace(/\.md$/, '')}</span>
            {['AGENTS.md', 'CLAUDE.md'].includes(node.name) && (
              <span className="agent-file-label">AI</span>
            )}
          </button>
        ),
      )}
    </>
  );
}

function WorkspaceFolder(props: Props & { node: TreeNode }) {
  const { root, node, refresh, depth = 0 } = props;
  const [expanded, setExpanded] = useState(false);
  const [listing, setListing] = useState({
    nodes: [] as TreeNode[],
    limited: false,
    loading: false,
    error: '',
  });
  const loader = useMemo(
    () =>
      createDirectoryListing((root, directory) => bridge.directory(root, directory), setListing),
    [],
  );
  useEffect(() => {
    if (expanded) void loader.open(root, node.path);
    else loader.close();
    return () => {
      loader.close();
      if (expanded) void bridge.releaseDirectory(root, node.path).catch(() => {});
    };
  }, [expanded, root, node.path, loader]);
  useEffect(() => {
    if (expanded) void loader.refresh();
  }, [refresh]);
  return (
    <div>
      <button
        className="tree-folder"
        style={{ paddingLeft: 14 + depth * 14 }}
        aria-expanded={expanded}
        aria-busy={expanded && listing.loading}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <Folder size={16} />
        <span>{node.name}</span>
      </button>
      {expanded && (
        <>
          <WorkspaceTree {...props} nodes={listing.nodes} depth={depth + 1} />
          {listing.loading && (
            <div className="sidebar-empty" role="status">
              {t('正在读取此文件夹…')}
            </div>
          )}
          {listing.error && (
            <div className="sidebar-empty" role="alert">
              <span>{t(listing.error)}</span>
              <button onClick={() => void loader.refresh()}>{t('重试')}</button>
            </div>
          )}
          {!listing.loading && !listing.error && !listing.nodes.length && (
            <div className="sidebar-empty">{t('此文件夹没有 Markdown 文档或子文件夹。')}</div>
          )}
          {listing.limited && (
            <div className="sidebar-empty">
              {t('此文件夹项目较多，仅显示部分内容。可直接打开所需文档。')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
