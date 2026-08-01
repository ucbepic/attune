"use client"

import React, { useState } from 'react';
import { toast } from 'sonner';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { ScoreDiff } from '@/hooks/use-versioning';
import type { AnnotationRecord, AnnotationDelta } from '@/hooks/use-scoring';

import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  ColumnResizeMode,
} from '@tanstack/react-table';

interface TableProps {
  data: Record<string, any>[]
  header: string | null;
  onDataChange?: (updatedData: Record<string, any>[], editedIds: (string | number)[]) => void;
  sampledIds?: (string | number)[];
  selectedNodeIds?: Set<string | number>;
  onNodeSelect?: (nodeIds: Set<string | number>) => void;
  onCriterionSelect?: (criterion: string | null) => void;
  mappedFeatures?: Record<string | number, Record<string, boolean>>;
  selectedCriterion?: string | null;
  scoreDiffs?: Record<string | number, ScoreDiff>;
  annotations?: Record<string, AnnotationRecord>;
  annotationDeltas?: Record<string, AnnotationDelta>;
  showValidationDecorators?: boolean;
}

const normalizeItemId = (id: string | number | null | undefined) => String(id);

const EditableCell: React.FC<{
  getValue: () => any;
  row: any;
  column: any;
  table: any;
}> = ({ getValue, row, column, table }) => {
  const initialValue = getValue();
  const [value, setValue] = useState(initialValue);

  React.useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);
  const isEditable = column.id.toLowerCase() === 'score';
  const cellRef = React.useRef<HTMLDivElement>(null);

  const saveValue = (newValue: string | null) => {
    if (isEditable && newValue !== null && newValue !== '') {
      const numValue = Number(newValue);
      if (isNaN(numValue) || !Number.isInteger(numValue)) {
        toast.error('Score must be an integer');
        if (cellRef.current) {
          cellRef.current.textContent = String(initialValue);
        }
        setValue(initialValue);
        return false;
      }
      setValue(numValue);
      if (numValue !== initialValue) {
        table.options.meta?.updateData(row.index, column.id, numValue, row.original.id || row.index);
      }
      return true;
    }

    setValue(newValue);
    if (newValue !== initialValue) {
      table.options.meta?.updateData(row.index, column.id, newValue, row.original.id || row.index);
    }
    return true;
  };

  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const newValue = e.currentTarget.textContent?.trim() || null;
    saveValue(newValue);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      const newValue = e.currentTarget.textContent?.trim() || null;
      if (saveValue(newValue)) {
        e.currentTarget.blur();
      }
    }
  };

  if (!isEditable) {
    return (
      <div className="px-3 py-1.5 break-words whitespace-pre-wrap leading-snug">
        {value}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={cellRef}
        contentEditable
        suppressContentEditableWarning
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className="w-full h-full bg-transparent border-none outline-none px-3 py-1.5 focus:bg-blue-50/50 break-words whitespace-pre-wrap leading-snug cursor-text"
      >
        {value}
      </div>
    </div>
  );
};

const PaginationControls: React.FC<{ table: any }> = ({ table }) => (
  <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50/50">
    <div className="flex items-center gap-1">
      {[
        { label: '<<', action: () => table.setPageIndex(0), disabled: !table.getCanPreviousPage() },
        { label: '<', action: () => table.previousPage(), disabled: !table.getCanPreviousPage() },
        { label: '>', action: () => table.nextPage(), disabled: !table.getCanNextPage() },
        { label: '>>', action: () => table.setPageIndex(table.getPageCount() - 1), disabled: !table.getCanNextPage() },
      ].map((btn) => (
        <button
          key={btn.label}
          onClick={btn.action}
          disabled={btn.disabled}
          className="px-2 py-0.5 text-xs font-medium text-gray-500 border border-gray-200 rounded hover:bg-white hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {btn.label}
        </button>
      ))}
    </div>
    <span className="text-xs text-gray-400">
      {table.getState().pagination.pageIndex + 1}/{table.getPageCount()} ({table.getFilteredRowModel().rows.length} rows)
    </span>
  </div>
);

const Table: React.FC<TableProps> = ({
  data: sourceData,
  header,
  onDataChange,
  sampledIds,
  selectedNodeIds,
  onNodeSelect,
  onCriterionSelect,
  mappedFeatures,
  selectedCriterion,
  scoreDiffs = {},
  annotations = {},
  annotationDeltas = {},
  showValidationDecorators = true,
}) => {
  const [data, setData] = useState(sourceData);
  const [editedIds, setEditedIds] = useState<(string | number)[]>([]);
  const [columnResizeMode] = useState<ColumnResizeMode>('onChange');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const sampledIdSet = React.useMemo(() => new Set(sampledIds?.map(id => String(id)) ?? []), [sampledIds]);
  const tableContainerRef = React.useRef<HTMLDivElement>(null);

  const isRowSelected = React.useCallback((rowId: string | number) => {
    if (!selectedNodeIds) return false;
    return selectedNodeIds.has(rowId) || selectedNodeIds.has(normalizeItemId(rowId));
  }, [selectedNodeIds]);

  const highlightedRowIds = React.useMemo(() => {
    if (!selectedCriterion || !mappedFeatures) return new Set<string | number>();

    const highlighted = new Set<string | number>();
    Object.entries(mappedFeatures).forEach(([nodeId, features]) => {
      if (features[selectedCriterion] === true) {
        const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
        highlighted.add(parsedId);
      }
    });
    return highlighted;
  }, [selectedCriterion, mappedFeatures]);

  const columns = React.useMemo(() => {
    if (!data || data.length === 0) return [];

    const firstRow = data[0];
    const shortCols = new Set(['id', 'score', 'label', 'index']);
    const visibleKeys = Object.keys(firstRow).filter((key) => !key.startsWith('_'));
    const orderedKeys = [
      ...visibleKeys.filter((key) => key.toLowerCase() === 'id'),
      ...visibleKeys.filter((key) => {
        const lower = key.toLowerCase();
        return lower !== 'id' && lower !== 'score';
      }),
      ...visibleKeys.filter((key) => key.toLowerCase() === 'score'),
    ];

    return orderedKeys.map((key) => {
      const isShort = shortCols.has(key.toLowerCase());
      return {
        accessorKey: key,
        header: key.charAt(0).toUpperCase() + key.slice(1),
        size: isShort ? 80 : 200,
        minSize: isShort ? 50 : 120,
        maxSize: isShort ? 120 : 800,
        cell: EditableCell,
      };
    });
  }, [data]);

  interface TableMeta {
    updateData: (rowIndex: number, columnId: string, value: any, rowId: string | number) => void;
  }

  const table = useReactTable({
    data,
    columns,
    columnResizeMode,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: 100,
      },
    },
    meta: {
      updateData: (rowIndex, columnId, value, rowId) => {
        const updatedData = data.map((row) => {
          if (row.id === rowId) {
            return {
              ...row,
              [columnId]: value,
            };
          }
          return row;
        });

        setData(updatedData);

        const originalRow = sourceData.find(r => r.id === rowId);
        const originalValue = originalRow?.[columnId];
        if (value !== originalValue) {
          const newEditedIds = [...new Set([...editedIds, rowId])];
          setEditedIds(newEditedIds);
          if (onDataChange) {
            onDataChange(updatedData, newEditedIds);
          }
        }
      },
    } as TableMeta,
  });

  React.useEffect(() => {
    setData(sourceData);
    setEditedIds([]);
  }, [sourceData]);

  React.useEffect(() => {
    if (!selectedNodeIds || selectedNodeIds.size === 0 || !tableContainerRef.current) return;

    const lastId = Array.from(selectedNodeIds).pop();
    if (!lastId) return;

    const rowIndex = data.findIndex(row => row.id === lastId);
    if (rowIndex === -1) return;

    const pageSize = table.getState().pagination.pageSize;
    const targetPage = Math.floor(rowIndex / pageSize);
    const currentPage = table.getState().pagination.pageIndex;

    if (targetPage !== currentPage) {
      table.setPageIndex(targetPage);
    }

    setTimeout(() => {
      const rowElement = tableContainerRef.current?.querySelector(`[data-row-id="${lastId}"]`);
      if (rowElement) {
        rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }, [selectedNodeIds, data, table]);

  if (!data || data.length === 0) {
    return (
      <div className="w-full bg-white p-8 text-center text-gray-500">
        No data available. Upload a dataset or select from sample datasets.
      </div>
    );
  }

  return (
    <div ref={tableContainerRef} className="w-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {header && (
        <div
          className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <h3 className="text-sm font-semibold text-gray-700">Score: {header}</h3>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
              isCollapsed ? '-rotate-90' : 'rotate-0'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      )}

      {!isCollapsed && (
        <>
          <PaginationControls table={table} />

          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id} className="border-b border-gray-200 bg-gray-50/80">
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{
                          width: header.getSize(),
                          minWidth: header.column.columnDef.minSize,
                          maxWidth: header.column.columnDef.maxSize,
                        }}
                        className="relative text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider border-r border-gray-100 last:border-r-0"
                      >
                        <div className="px-3 py-2 truncate">
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                        </div>
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className={`absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none hover:bg-gray-300 ${
                            header.column.getIsResizing() ? 'bg-gray-400' : ''
                          }`}
                        />
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => {
                  const rowId = row.original.id;
                  const isSampled = rowId !== undefined && sampledIdSet.has(String(rowId));
                  const isSelected = rowId !== undefined && isRowSelected(rowId);
                  const isHighlightedByCriterion = rowId !== undefined && (highlightedRowIds.has(rowId) || highlightedRowIds.has(normalizeItemId(rowId)));
                  const annotation = rowId !== undefined ? annotations[normalizeItemId(rowId)] : undefined;
                  const validationDelta = rowId !== undefined ? annotationDeltas[normalizeItemId(rowId)] : undefined;
                  const isValidationCorrect = validationDelta?.absoluteDelta === 0;
                  const isValidationIncorrect = validationDelta != null && validationDelta.absoluteDelta > 0;
                  return (
                    <tr
                      key={row.id}
                      data-row-id={rowId}
                      onClick={(e) => {
                        if (rowId !== undefined) {
                          if (onCriterionSelect) {
                            onCriterionSelect(null);
                          }
                          if (onNodeSelect) {
                            if (e.metaKey || e.ctrlKey) {
                              const next = new Set(selectedNodeIds);
                              if (next.has(rowId)) {
                                next.delete(rowId);
                              } else {
                                next.add(rowId);
                              }
                              onNodeSelect(next);
                            } else {
                              if (selectedNodeIds?.size === 1 && selectedNodeIds.has(rowId)) {
                                onNodeSelect(new Set());
                              } else {
                                onNodeSelect(new Set([rowId]));
                              }
                            }
                          }
                        }
                      }}
                      className={`border-b border-gray-100 transition-colors cursor-pointer ${
                        isSelected || isHighlightedByCriterion
                          ? 'bg-teal-50 ring-1 ring-inset ring-teal-600'
                          : showValidationDecorators && isValidationCorrect
                            ? 'bg-green-50/50 border-l-2 border-l-dotted border-l-green-500'
                            : showValidationDecorators && isValidationIncorrect
                              ? 'bg-red-50/40 border-l-2 border-l-dotted border-l-red-500'
                              : annotation
                                ? 'bg-amber-50/60 border-l-2 border-l-amber-400'
                            : ''
                      }`}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isScoreColumn = cell.column.id.toLowerCase() === 'score';
                        const diff = isScoreColumn && rowId !== undefined ? scoreDiffs[rowId] : undefined;
                        const delta = isScoreColumn && rowId !== undefined ? annotationDeltas[normalizeItemId(rowId)] : undefined;
                        return (
                        <td
                          key={cell.id}
                          style={{
                            width: cell.column.getSize(),
                            minWidth: cell.column.columnDef.minSize,
                            maxWidth: cell.column.columnDef.maxSize,
                          }}
                          className="text-[13px] text-gray-700 border-r border-gray-100 last:border-r-0 align-top"
                        >
                          <div className="break-words whitespace-pre-wrap">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            {diff && (
                              <span className={`inline-flex items-center ml-1 text-xs ${
                                diff.direction === 'up' ? 'text-green-600' : diff.direction === 'down' ? 'text-red-500' : 'text-gray-400'
                              }`}>
                                {diff.direction === 'up' && <ArrowUp className="h-3 w-3" />}
                                {diff.direction === 'down' && <ArrowDown className="h-3 w-3" />}
                                {diff.direction === 'new' && <span className="text-blue-500 font-medium">new</span>}
                                {(diff.direction === 'up' || diff.direction === 'down') && diff.oldScore !== null && (
                                  <span className="text-gray-400 ml-0.5">(was {diff.oldScore})</span>
                                )}
                              </span>
                            )}
                            {showValidationDecorators && delta && (
                              <span className={`inline-flex items-center ml-1 text-xs ${
                                delta.absoluteDelta > 0
                                  ? 'text-red-500'
                                  : 'text-green-600'
                              }`}>
                                {delta.absoluteDelta > 0 && (
                                  <span className="ml-0.5">{delta.direction === 'up' ? '+' : delta.direction === 'down' ? '-' : ''}{delta.absoluteDelta.toFixed(2)}</span>
                                )}
                              </span>
                            )}
                          </div>
                        </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PaginationControls table={table} />
        </>
      )}
    </div>
  );
};

export default Table;
