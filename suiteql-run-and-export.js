/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @author Eric Pinel
 * @license MIT
 *
 * SuiteQL Run and Export
 * Copyright (c) 2026 Eric Pinel. Licensed under MIT.
 *
 * Preview:
 *   - runSuiteQL() by default
 *   - runSuiteQLPaged() with page navigation
 *   - Live Table / CSV switching
 *   - Local SuiteQL syntax highlighting
 *
 * Export:
 *   - Native asynchronous SUITE_QL task
 *   - Unique temporary CSV, renamed after completion to the folder name
 *     plus "_" and the last 20 characters of the task ID
 *   - Spinner, status stages, and elapsed timer
 *   - Download to browser, then delete the server file
 *
 * Deploy internally using Current Role.
 * Intended for one export at a time per session.
 */
define([
    'N/query',
    'N/task',
    'N/file',
    'N/record',
    'N/runtime',
    'N/url',
    'N/ui/serverWidget',
    'N/log'
], (
    query,
    task,
    file,
    record,
    runtime,
    url,
    serverWidget,
    log
) => {
    const CONFIG = {
        FOLDER_NAME: 'NETSUITE SUITEQL run and export tool',
        PAGE_SIZE: 1000,
        SESSION_KEY: 'simple_suiteql_export'
    };

    // =====================================================================
    // REQUEST ROUTING
    // =====================================================================

    function onRequest(context) {
        try {
            const action = context.request.parameters.action;

            if (
                context.request.method === 'GET' &&
                action === 'download'
            ) {
                downloadExport(context);
                return;
            }

            if (context.request.method === 'POST') {
                handlePost(context);
                return;
            }

            renderPage(context);
        } catch (e) {
            log.error({
                title: 'SuiteQL Tool Error',
                details: e
            });

            if (context.request.method === 'POST') {
                writeJson(context, {
                    error: e.message || String(e)
                });
            } else {
                context.response.setHeader({
                    name: 'Content-Type',
                    value: 'text/plain; charset=UTF-8'
                });

                context.response.write({
                    output: 'Error: ' + (e.message || String(e))
                });
            }
        }
    }

    function handlePost(context) {
        const payload = JSON.parse(context.request.body || '{}');

        switch (payload.action) {
            case 'run':
                return runQuery(context, payload);

            case 'export':
                return startExport(context, payload);

            case 'status':
                return getExportStatus(context);

            case 'delete':
                return deleteExport(context);

            default:
                throw new Error('Unknown action.');
        }
    }

    function writeJson(context, value) {
        context.response.setHeader({
            name: 'Content-Type',
            value: 'application/json; charset=UTF-8'
        });

        context.response.setHeader({
            name: 'Cache-Control',
            value: 'no-store'
        });

        context.response.write({
            output: JSON.stringify(value)
        });
    }

    function requireSql(value) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error('Enter a SuiteQL query.');
        }

        const sql = value.trim().replace(/;\s*$/, '');

        if (!sql.trim()) {
            throw new Error('Enter a SuiteQL query.');
        }

        return sql;
    }

    // =====================================================================
    // QUERY PREVIEW
    // =====================================================================

    function getRows(resultSet) {
        return (resultSet.results || []).map(
            result => result.values || []
        );
    }

    function getColumnNames(resultSet, rows) {
        const width = rows.length ? rows[0].length : 0;
        const columns = resultSet.columns;

        if (
            Array.isArray(columns) &&
            columns.length > 0 &&
            (width === 0 || columns.length === width)
        ) {
            return columns.map((column, index) =>
                (
                    column &&
                    (column.alias || column.fieldId || column.label)
                ) ||
                ('column_' + (index + 1))
            );
        }

        if (!width) {
            return [];
        }

        try {
            const mapped = resultSet.asMappedResults() || [];

            if (mapped.length) {
                const keys = Object.keys(mapped[0]);

                if (keys.length === width) {
                    return keys;
                }
            }
        } catch (e) {
            log.debug({
                title: 'Column header fallback',
                details: e.message
            });
        }

        // Duplicate column names can collapse in mapped results.
        return rows[0].map(
            (value, index) => 'column_' + (index + 1)
        );
    }

    function runQuery(context, payload) {
        const sql = requireSql(payload.sql);
        const started = Date.now();

        if (payload.paginated !== true) {
            const resultSet = query.runSuiteQL({
                query: sql,
                params: []
            });

            const rows = getRows(resultSet);

            writeJson(context, {
                columns: getColumnNames(resultSet, rows),
                rows: rows,
                count: rows.length,
                paginated: false,
                pageIndex: 0,
                pageCount: 1,
                elapsedMs: Date.now() - started
            });

            return;
        }

        const pageIndex = Number(payload.pageIndex || 0);

        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
            throw new Error('Invalid page index.');
        }

        const paged = query.runSuiteQLPaged({
            query: sql,
            params: [],
            pageSize: CONFIG.PAGE_SIZE
        });

        const pageRanges = paged.pageRanges || [];
        const pageCount = pageRanges.length;

        if (!pageCount) {
            writeJson(context, {
                columns: [],
                rows: [],
                count: 0,
                paginated: true,
                pageIndex: 0,
                pageCount: 0,
                elapsedMs: Date.now() - started
            });

            return;
        }

        if (pageIndex >= pageCount) {
            throw new Error('Requested page does not exist.');
        }

        const page = paged.fetch({
            index: pageIndex
        });

        const rows = getRows(page.data);

        writeJson(context, {
            columns: getColumnNames(page.data, rows),
            rows: rows,
            count: paged.count,
            paginated: true,
            pageIndex: pageIndex,
            pageCount: pageCount,
            elapsedMs: Date.now() - started
        });
    }

    // =====================================================================
    // EXPORT FOLDER / FILE
    // =====================================================================

    function getExportFolder() {
        const matches = query.runSuiteQL({
            query: `
                SELECT id
                FROM MediaItemFolder
                WHERE name = ?
                  AND istoplevel = 'T'
            `,
            params: [CONFIG.FOLDER_NAME]
        }).asMappedResults();

        if (matches.length > 1) {
            throw new Error(
                'Multiple root export folders exist. ' +
                'Remove or rename the duplicates.'
            );
        }

        if (matches.length === 1) {
            return Number(matches[0].id);
        }

        const folder = record.create({
            type: record.Type.FOLDER,
            isDynamic: false
        });

        folder.setValue({
            fieldId: 'name',
            value: CONFIG.FOLDER_NAME
        });

        // No parent: create at root level.
        return Number(folder.save());
    }

    function getExportFilename(taskId) {
        return CONFIG.FOLDER_NAME + '_' +
            String(taskId).slice(-20) + '.csv';
    }

    function readMetadata(fileObject) {
        try {
            return JSON.parse(fileObject.description || '{}');
        } catch (e) {
            return {};
        }
    }

    function newToken() {
        return Date.now().toString(36) +
            Math.random().toString(36).slice(2) +
            Math.random().toString(36).slice(2);
    }

    function getSessionKey() {
        const script = runtime.getCurrentScript();

        return CONFIG.SESSION_KEY +
            '_' + script.id +
            '_' + script.deploymentId;
    }

    function saveSessionExport(info) {
        runtime.getCurrentSession().set({
            name: getSessionKey(),
            value: JSON.stringify(info)
        });
    }

    function readSessionExport(required = true) {
        const raw = runtime.getCurrentSession().get({
            name: getSessionKey()
        });

        if (!raw) {
            if (!required) {
                return null;
            }

            throw new Error(
                'No export is associated with this session.'
            );
        }

        const info = JSON.parse(raw);

        if (
            String(info.userId) !==
            String(runtime.getCurrentUser().id)
        ) {
            throw new Error('This export belongs to another user.');
        }

        if (!info.fileId || !info.taskId || !info.token) {
            throw new Error('Incomplete export information.');
        }

        return info;
    }

    function clearSessionExport() {
        runtime.getCurrentSession().set({
            name: getSessionKey(),
            value: ''
        });
    }

    function loadOwnedExport(info) {
        const exportFile = file.load({
            id: info.fileId
        });

        const metadata = readMetadata(exportFile);

        if (
            (
                exportFile.name !== (
                    info.temporaryFilename || 'suiteql-export.csv'
                ) &&
                exportFile.name !== getExportFilename(info.taskId)
            ) ||
            (
                info.folderId &&
                String(exportFile.folder) !== String(info.folderId)
            ) ||
            metadata.tool !== 'simple-suiteql' ||
            metadata.token !== info.token ||
            String(metadata.userId) !==
                String(runtime.getCurrentUser().id)
        ) {
            throw new Error(
                'Export ownership verification failed.'
            );
        }

        return exportFile;
    }

    // =====================================================================
    // NATIVE CSV EXPORT
    // =====================================================================

    function startExport(context, payload) {
        const sql = requireSql(payload.sql);
        const folderId = getExportFolder();
        const previousInfo = readSessionExport(false);

        if (previousInfo) {
            loadOwnedExport(previousInfo);

            const previousStatus = task.checkStatus({
                taskId: previousInfo.taskId
            });

            const finished =
                previousStatus.status === task.TaskStatus.FAILED ||
                previousStatus.status === task.TaskStatus.COMPLETE;

            if (finished) {
                /*
                 * This is a new export request.
                 * Remove the old, finished output and execute the requested SQL.
                 * Never silently return an old completed CSV.
                 */
                file.delete({
                    id: previousInfo.fileId
                });

                clearSessionExport();
            } else if (
                (
                    previousStatus.status === task.TaskStatus.PENDING ||
                    previousStatus.status === task.TaskStatus.PROCESSING
                ) &&
                previousInfo.sql === sql
            ) {
                // Resume only a known active task for exactly the same SQL.
                writeJson(context, {
                    submitted: true,
                    resumed: true,
                    taskId: previousInfo.taskId,
                    filename: getExportFilename(previousInfo.taskId)
                });

                return;
            } else {
                throw new Error(
                    'A previous export is still active and its SQL does not ' +
                    'match this request, or its query cannot be verified. ' +
                    'Wait for it to finish, then export again.'
                );
            }
        }

        const info = {
            tool: 'simple-suiteql',
            userId: runtime.getCurrentUser().id,
            token: newToken(),
            createdAt: new Date().toISOString(),
            folderId: folderId,
            fileId: null,
            taskId: null
        };

        info.temporaryFilename = CONFIG.FOLDER_NAME +
            '_pending_' + info.token + '.csv';

        const outputFile = file.create({
            name: info.temporaryFilename,
            fileType: file.Type.CSV,
            contents: ' ',
            folder: folderId,
            isOnline: false,

            // SQL is deliberately excluded from the file description.
            description: JSON.stringify(info)
        });

        info.fileId = outputFile.save();

        let submitted = false;

        try {
            const exportTask = task.create({
                taskType: task.TaskType.SUITE_QL
            });

            exportTask.query = sql;
            exportTask.params = [];
            exportTask.fileId = info.fileId;

            info.taskId = exportTask.submit();
            submitted = true;

            // SQL is stored only in session information for resume comparison.
            info.sql = sql;

            /*
             * Do not load/save the CSV after submission:
             * the background task may already be writing to it.
             */
            saveSessionExport(info);

            writeJson(context, {
                submitted: true,
                resumed: false,
                taskId: info.taskId,
                filename: getExportFilename(info.taskId)
            });
        } catch (e) {
            if (!submitted) {
                try {
                    file.delete({
                        id: info.fileId
                    });
                } catch (cleanupError) {
                    log.error({
                        title: 'Export cleanup failed',
                        details: cleanupError
                    });
                }
            } else {
                log.error({
                    title: 'Export submitted but session/response failed',
                    details: JSON.stringify({
                        fileId: info.fileId,
                        taskId: info.taskId,
                        message: e.message
                    })
                });
            }

            throw e;
        }
    }

    function getExportStatus(context) {
        const info = readSessionExport();

        // Ownership validation retained for safety.
        loadOwnedExport(info);

        const result = task.checkStatus({
            taskId: info.taskId
        });

        const failed =
            result.status === task.TaskStatus.FAILED;

        if (failed) {
            file.delete({
                id: info.fileId
            });

            clearSessionExport();
        }

        writeJson(context, {
            status: result.status,
            complete:
                result.status === task.TaskStatus.COMPLETE,
            failed: failed,
            filename: getExportFilename(info.taskId)
        });
    }

    function downloadExport(context) {
        const info = readSessionExport();

        const result = task.checkStatus({
            taskId: info.taskId
        });

        if (result.status !== task.TaskStatus.COMPLETE) {
            throw new Error('The export is not complete.');
        }

        const exportFile = loadOwnedExport(info);
        const filename = getExportFilename(info.taskId);

        // The task has stopped writing, so renaming cannot race its output.
        if (exportFile.name !== filename) {
            exportFile.name = filename;
            exportFile.save();
        }

        context.response.setHeader({
            name: 'Cache-Control',
            value: 'no-store'
        });

        context.response.writeFile({
            file: exportFile,
            isInline: false
        });
    }

    function deleteExport(context) {
        const info = readSessionExport();
        loadOwnedExport(info);

        const result = task.checkStatus({
            taskId: info.taskId
        });

        if (result.status !== task.TaskStatus.COMPLETE) {
            throw new Error(
                'Cannot delete an export that is still running.'
            );
        }

        file.delete({
            id: info.fileId
        });

        clearSessionExport();

        writeJson(context, {
            deleted: true
        });
    }

    // =====================================================================
    // UI GENERATION
    // =====================================================================

    function renderPage(context) {
        const script = runtime.getCurrentScript();

        const scriptUrl = url.resolveScript({
            scriptId: script.id,
            deploymentId: script.deploymentId,
            returnExternalURL: false
        });

        const form = serverWidget.createForm({
            title: 'SuiteQL Run and Export'
        });

        const html = form.addField({
            id: 'custpage_html',
            type: serverWidget.FieldType.INLINEHTML,
            label: 'Tool'
        });

        html.defaultValue = buildHtml(scriptUrl);

        context.response.writePage({
            pageObject: form
        });
    }

    function buildHtml(scriptUrl) {
        const browserConfig = JSON.stringify({
            endpoint: scriptUrl
        }).replace(/</g, '\\u003c');

        return `
<style>
    #sqt {
        font: 14px Arial, sans-serif;
        color: #222;
        padding: 12px;
    }

    #sqt textarea {
        box-sizing: border-box;
        width: 100%;
        font: 13px Consolas, monospace;
        padding: 12px;
        border: 1px solid #bbb;
        border-radius: 4px;
    }

    #sqt .sql-editor {
        position: relative;
        height: 220px;
        min-height: 100px;
        resize: vertical;
        overflow: hidden;
        border: 1px solid #bbb;
        border-radius: 4px;
        background: #fff;
    }

    #sqt .sql-editor:focus-within {
        outline: 2px solid #bfdbfe;
        border-color: #2563eb;
    }

    #sqt .sql-editor pre,
    #sqt .sql-editor textarea {
        position: absolute;
        top: 0;
        left: 0;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 12px;
        border: 0;
        border-radius: 0;
        font: 13px/1.5 Consolas, monospace;
        letter-spacing: normal;
        white-space: pre;
        overflow-wrap: normal;
        word-break: normal;
        tab-size: 4;
        text-align: left;
    }

    #sqt #sqtHighlight {
        color: #24292f;
        overflow: hidden;
        pointer-events: none;
    }

    #sqt #sqtSql {
        resize: none;
        overflow: auto;
        background: transparent;
        color: transparent;
        -webkit-text-fill-color: transparent;
        caret-color: #24292f;
        outline: none;
    }

    #sqtSql::selection {
        background: rgba(37, 99, 235, .2);
    }

    #sqt .sql-keyword { color: #8250df; }
    #sqt .sql-function { color: #0550ae; }
    #sqt .sql-string { color: #0a6b32; }
    #sqt .sql-number { color: #9a4000; }
    #sqt .sql-comment { color: #6e7781; }
    #sqt .sql-operator { color: #cf222e; }

    @media (forced-colors: active) {
        #sqt #sqtHighlight { visibility: hidden; }
        #sqt #sqtSql {
            color: CanvasText;
            -webkit-text-fill-color: CanvasText;
            caret-color: CanvasText;
        }
    }

    #sqt .toolbar,
    #sqt .page-controls {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }

    #sqt .toolbar {
        margin: 12px 0;
    }

    #sqt button {
        padding: 7px 13px;
        border: 1px solid #aaa;
        border-radius: 4px;
        background: #fff;
        cursor: pointer;
        font: inherit;
    }

    #sqt button.primary {
        background: #245e91;
        color: white;
        border-color: #245e91;
    }

    #sqt button.export {
        background: #7c3aed;
        color: white;
        border-color: #7c3aed;
    }

    #sqt button:disabled {
        opacity: .5;
        cursor: default;
    }

    #sqt [hidden] {
        display: none !important;
    }

    #sqt .muted {
        color: #666;
        font-size: 12px;
        line-height: 1.5;
    }

    #sqtStatus {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 14px 0;
        padding: 14px 16px;
        min-height: 58px;
        border: 1px solid #dbe2ea;
        border-left: 4px solid #94a3b8;
        border-radius: 6px;
        background: #f8fafc;
        color: #334155;
    }

    #sqt .status-content {
        flex: 1;
        min-width: 0;
    }

    #sqtStatusTitle {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 5px;
    }

    #sqtStatusText {
        font-size: 13px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.5;
    }

    #sqtElapsed {
        margin-top: 5px;
        font-size: 12px;
        opacity: .8;
    }

    #sqtStatus.is-running {
        background: #eff6ff;
        border-color: #bfdbfe;
        border-left-color: #2563eb;
        color: #1e40af;
    }

    #sqtStatus.is-exporting {
        background: #f5f3ff;
        border-color: #ddd6fe;
        border-left-color: #7c3aed;
        color: #5b21b6;
    }

    #sqtStatus.is-success {
        background: #ecfdf5;
        border-color: #a7f3d0;
        border-left-color: #059669;
        color: #065f46;
    }

    #sqtStatus.is-error {
        background: #fef2f2;
        border-color: #fecaca;
        border-left-color: #dc2626;
        color: #991b1b;
    }

    #sqtStatusSpinner {
        display: none;
        width: 23px;
        height: 23px;
        flex-shrink: 0;
        border: 3px solid rgba(37, 99, 235, .18);
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: sqt-spin .8s linear infinite;
    }

    #sqtStatus.is-running #sqtStatusSpinner,
    #sqtStatus.is-exporting #sqtStatusSpinner {
        display: block;
    }

    #sqtStatus.is-exporting #sqtStatusSpinner {
        border-color: rgba(124, 58, 237, .18);
        border-top-color: #7c3aed;
    }

    @keyframes sqt-spin {
        to { transform: rotate(360deg); }
    }

    #sqtPageNumber {
        box-sizing: border-box;
        width: 85px;
        padding: 7px 8px;
        border: 1px solid #aaa;
        border-radius: 4px;
        font: inherit;
        text-align: center;
    }

    #sqtPageNumber:focus {
        outline: 2px solid #bfdbfe;
        border-color: #2563eb;
    }

    #sqtPageNumber:disabled {
        background: #f1f5f9;
        color: #94a3b8;
    }

    #sqtPage {
        font-size: 12px;
        color: #64748b;
    }

    #sqtResults {
        border: 1px solid #ccc;
        max-height: 550px;
        overflow: auto;
    }

    #sqt table {
        border-collapse: separate;
        border-spacing: 0;
        width: 100%;
        font-size: 12px;
    }

    #sqt th,
    #sqt td {
        border-right: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        padding: 6px 9px;
        text-align: left;
        white-space: nowrap;
    }

    #sqt th {
        position: sticky;
        top: 0;
        background: #eef2f6;
        z-index: 1;
    }

    #sqt tbody tr:nth-child(even) {
        background: #fafafa;
    }

    #sqtCsv {
        height: 450px;
        border: 0 !important;
        resize: vertical;
    }

    @media (prefers-reduced-motion: reduce) {
        #sqtStatusSpinner {
            animation-duration: 2s;
        }
    }
</style>

<div id="sqt">
    <div class="sql-editor">
        <pre id="sqtHighlight" aria-hidden="true"></pre>
        <textarea id="sqtSql" aria-label="SuiteQL query" spellcheck="false"
            autocapitalize="off" autocomplete="off" wrap="off">SELECT
    id,
    entityid
FROM Customer
ORDER BY id</textarea>
    </div>

    <div class="toolbar">
        <button type="button" id="sqtRun" class="primary">Run</button>

        <label>
            <input type="checkbox" id="sqtPaginated">
            Paginated preview
        </label>

        <button type="button" id="sqtExport" class="export">
            Export full CSV
        </button>

        <button type="button" id="sqtRetry" hidden>
            Retry download / cleanup
        </button>
    </div>

    <div class="muted">
        Default preview: up to 5,000 rows.
        Paginated preview: ${CONFIG.PAGE_SIZE} rows per page.
        Use a unique, stable ORDER BY; page navigation executes the query again.
        Table / CSV switches the current preview without rerunning SQL.
        Full CSV export uses the SQL in the editor.
        CSV filenames use the export folder name and last 20 task ID characters.
        Only one export per session at a time; NetSuite platform limits apply.
    </div>

    <div id="sqtStatus" role="status" aria-live="polite">
        <span id="sqtStatusSpinner" aria-hidden="true"></span>
        <div class="status-content">
            <div id="sqtStatusTitle">Ready</div>
            <div id="sqtStatusText">Enter SQL and click Run.</div>
            <div id="sqtElapsed" aria-live="off" hidden></div>
        </div>
    </div>

    <div class="toolbar">
        <label>
            <input type="radio" name="sqtView" value="table" checked>
            Table
        </label>

        <label>
            <input type="radio" name="sqtView" value="csv">
            CSV
        </label>

        <span style="flex:1"></span>

        <div class="page-controls">
            <button type="button" id="sqtPrevious" disabled>
                Previous
            </button>

            <label for="sqtPageNumber">Page</label>

            <input
                type="number"
                id="sqtPageNumber"
                min="1"
                step="1"
                value="1"
                disabled
            >

            <span id="sqtPage">of —</span>

            <button type="button" id="sqtGo" disabled>Go</button>
            <button type="button" id="sqtNext" disabled>Next</button>
        </div>
    </div>

    <div id="sqtResults">
        <div style="padding:20px;color:#666;">
            Run a query to display results.
        </div>
    </div>

    <footer class="muted" style="margin-top:12px;text-align:center;font-size:16px;">
        Built by <a href="https://www.linkedin.com/in/eric-pinel-5a9820248/"
            target="_blank" rel="noopener noreferrer">Eric Pinel</a>
    </footer>
</div>

<script>
(${browserApp.toString()})(${browserConfig});
</script>
`;
    }

    // =====================================================================
    // BROWSER APPLICATION
    // Serialized into the HTML. Do not reference server-side modules here.
    // =====================================================================

    function browserApp(config) {
        'use strict';

        const ENDPOINT = config.endpoint;
        const el = id => document.getElementById(id);

        let results = null;
        let executedSql = '';
        let executedPaginated = false;

        let running = false;
        let exporting = false;
        let exportPending = false;
        let downloadTriggered = false;
        let exportFilename = '';

        let timerId = null;
        let operationStarted = 0;

        // -----------------------------------------------------------------
        // STATUS / TIMER
        // -----------------------------------------------------------------

        function setStatus(kind, title, message) {
            const panel = el('sqtStatus');

            panel.className = kind ? 'is-' + kind : '';

            el('sqtStatusTitle').textContent = title;
            el('sqtStatusText').textContent = message;

            panel.setAttribute(
                'aria-busy',
                kind === 'running' || kind === 'exporting'
                    ? 'true'
                    : 'false'
            );
        }

        function formatElapsed(ms) {
            const total = Math.floor(ms / 1000);
            const minutes = Math.floor(total / 60);
            const seconds = total % 60;

            return minutes
                ? minutes + 'm ' + seconds + 's'
                : seconds + 's';
        }

        function updateElapsed() {
            el('sqtElapsed').textContent =
                'Elapsed: ' +
                formatElapsed(Date.now() - operationStarted);
        }

        function startTimer() {
            if (timerId) {
                clearInterval(timerId);
            }

            operationStarted = Date.now();
            el('sqtElapsed').hidden = false;
            updateElapsed();
            timerId = setInterval(updateElapsed, 1000);
        }

        function stopTimer() {
            if (timerId) {
                clearInterval(timerId);
                timerId = null;
            }

            if (operationStarted) {
                updateElapsed();
            }
        }

        // -----------------------------------------------------------------
        // API
        // -----------------------------------------------------------------

        async function api(action, values) {
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(Object.assign({
                    action: action
                }, values || {}))
            });

            if (!response.ok) {
                throw new Error('HTTP error ' + response.status);
            }

            let data;

            try {
                data = await response.json();
            } catch (e) {
                throw new Error(
                    'The server did not return JSON. ' +
                    'Your session may have expired.'
                );
            }

            if (data.error) {
                throw new Error(data.error);
            }

            return data;
        }

        // -----------------------------------------------------------------
        // RESULTS
        // -----------------------------------------------------------------

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // -----------------------------------------------------------------
        // SQL EDITOR
        // -----------------------------------------------------------------

        const sqlKeywords = new Set((
            'ALL AND ANY AS ASC BETWEEN BY CASE CONNECT CROSS CURRENT_DATE ' +
            'CURRENT_TIMESTAMP DATE DECODE DESC DISTINCT ELSE END ESCAPE ' +
            'EXCEPT EXISTS FALSE FETCH FIRST FOLLOWING FROM FULL GROUP ' +
            'HAVING IN INNER INTERSECT INTERVAL IS JOIN LEFT LIKE MINUS ' +
            'NOT NULL NULLS OFFSET ON OR ORDER OUTER OVER PARTITION ' +
            'PRECEDING PRIOR RANGE RIGHT ROW ROWS SELECT START SYSDATE ' +
            'THEN TIMESTAMP TRUE UNION UNIQUE UNBOUNDED USING WHEN WHERE WITH'
        ).split(' '));

        function syncSqlScroll() {
            const input = el('sqtSql');
            const highlight = el('sqtHighlight');

            highlight.style.width = input.clientWidth + 'px';
            highlight.style.height = input.clientHeight + 'px';
            highlight.scrollTop = input.scrollTop;
            highlight.scrollLeft = input.scrollLeft;
        }

        function highlightSql() {
            const sql = el('sqtSql').value;
            const tokens = /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|(?:\b\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*|[<>=!|+*/%-]+/g;
            let html = '';
            let position = 0;
            let match;

            while ((match = tokens.exec(sql)) !== null) {
                const text = match[0];
                let kind = '';

                if (text.startsWith('--') || text.startsWith('/*')) {
                    kind = 'comment';
                } else if (text[0] === "'") {
                    kind = 'string';
                } else if (/^(?:\d|\.\d)/.test(text)) {
                    kind = 'number';
                } else if (sqlKeywords.has(text.toUpperCase())) {
                    kind = 'keyword';
                } else if (
                    /^[A-Za-z_]/.test(text) &&
                    /^\s*\(/.test(sql.slice(tokens.lastIndex))
                ) {
                    kind = 'function';
                } else if (/^[<>=!|+*/%-]/.test(text)) {
                    kind = 'operator';
                }

                html += escapeHtml(sql.slice(position, match.index));
                html += kind
                    ? '<span class="sql-' + kind + '">' +
                        escapeHtml(text) + '</span>'
                    : escapeHtml(text);
                position = tokens.lastIndex;
            }

            // A final space preserves the last empty line when SQL ends in LF.
            el('sqtHighlight').innerHTML =
                html + escapeHtml(sql.slice(position)) + ' ';
            syncSqlScroll();
        }

        function csvCell(value) {
            const text = value == null ? '' : String(value);
            return '"' + text.replace(/"/g, '""') + '"';
        }

        function buildCsv(data) {
            const lines = [
                (data.columns || []).map(csvCell).join(',')
            ];

            (data.rows || []).forEach(row => {
                lines.push((row || []).map(csvCell).join(','));
            });

            return lines.join('\r\n');
        }

        function renderResults() {
            if (!results) return;

            const columns = results.columns || [];
            const rows = results.rows || [];

            const view = document.querySelector(
                '#sqt input[name="sqtView"]:checked'
            ).value;

            if (view === 'csv') {
                const textarea = document.createElement('textarea');

                textarea.id = 'sqtCsv';
                textarea.readOnly = true;
                textarea.value = buildCsv(results);

                el('sqtResults').replaceChildren(textarea);
                return;
            }

            if (!rows.length) {
                el('sqtResults').innerHTML =
                    '<div style="padding:20px;">No results.</div>';
                return;
            }

            let html = '<table><thead><tr>';

            columns.forEach(column => {
                html += '<th>' + escapeHtml(column) + '</th>';
            });

            html += '</tr></thead><tbody>';

            rows.forEach(row => {
                html += '<tr>';

                (row || []).forEach(value => {
                    html += '<td>' + escapeHtml(value) + '</td>';
                });

                html += '</tr>';
            });

            html += '</tbody></table>';

            el('sqtResults').innerHTML = html;
            el('sqtResults').scrollTop = 0;
        }

        // -----------------------------------------------------------------
        // BUTTONS / PAGINATION
        // -----------------------------------------------------------------

        function updateButtons(syncPageNumber) {
            const busy = running || exporting;

            el('sqtRun').disabled = busy;
            el('sqtExport').disabled = busy || exportPending;
            el('sqtRetry').disabled = busy;
            el('sqtRetry').hidden = !exportPending;
            el('sqtPaginated').disabled = busy;

            el('sqtRun').textContent =
                running ? 'Running...' : 'Run';

            el('sqtExport').textContent =
                exporting ? 'Exporting CSV...' : 'Export full CSV';

            const hasPages = Boolean(
                results &&
                results.paginated &&
                results.pageCount > 0
            );

            const canPage = hasPages && !busy;

            el('sqtPrevious').disabled =
                !canPage || results.pageIndex <= 0;

            el('sqtNext').disabled =
                !canPage ||
                results.pageIndex + 1 >= results.pageCount;

            el('sqtPageNumber').disabled = !canPage;
            el('sqtGo').disabled = !canPage;

            // Only change the input when explicitly synchronizing results.
            if (syncPageNumber) {
                el('sqtPageNumber').value =
                    hasPages ? results.pageIndex + 1 : 1;
            }

            el('sqtPageNumber').max =
                hasPages ? results.pageCount : 1;

            el('sqtPage').textContent =
                hasPages
                    ? 'of ' + results.pageCount.toLocaleString()
                    : 'of —';
        }

        async function run(pageIndex, newQuery) {
            if (running || exporting) return;

            const sql = newQuery
                ? el('sqtSql').value.trim()
                : executedSql;

            const paginated = newQuery
                ? el('sqtPaginated').checked
                : executedPaginated;

            if (!sql) {
                setStatus(
                    'error',
                    'SQL required',
                    'Enter a SQL query.'
                );
                return;
            }

            running = true;
            updateButtons(false);
            startTimer();

            setStatus(
                'running',
                paginated
                    ? 'Loading page ' + (pageIndex + 1)
                    : 'Running query',
                'NetSuite is executing your SQL. Please wait...'
            );

            try {
                const data = await api('run', {
                    sql: sql,
                    paginated: paginated,
                    pageIndex: pageIndex
                });

                executedSql = sql;
                executedPaginated = paginated;
                results = data;

                renderResults();
                updateButtons(true);

                const shown = (results.rows || []).length;
                let message = shown.toLocaleString() + ' rows displayed';

                if (results.paginated) {
                    message +=
                        ' / ' +
                        Number(results.count).toLocaleString() +
                        ' total rows';
                } else if (shown === 5000) {
                    message +=
                        ' — preview reached the 5,000-row limit';
                }

                message +=
                    ' | Server execution: ' +
                    results.elapsedMs + ' ms';

                setStatus('success', 'Query complete', message);
            } catch (e) {
                setStatus('error', 'Query failed', e.message);
            } finally {
                running = false;
                stopTimer();
                updateButtons(false);
            }
        }

        function goToPage() {
            if (
                running ||
                exporting ||
                !results ||
                !results.paginated ||
                !results.pageCount
            ) {
                return;
            }

            const raw = el('sqtPageNumber').value.trim();
            const requestedPage = Number(raw);

            if (
                !raw ||
                !Number.isInteger(requestedPage) ||
                requestedPage < 1 ||
                requestedPage > results.pageCount
            ) {
                setStatus(
                    'error',
                    'Invalid page number',
                    'Enter a page number between 1 and ' +
                    results.pageCount + '.'
                );

                el('sqtPageNumber').focus();
                return;
            }

            run(requestedPage - 1, false);
        }

        // -----------------------------------------------------------------
        // EXPORT
        // -----------------------------------------------------------------

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async function waitForExport() {
            while (true) {
                const data = await api('status');

                if (data.failed) {
                    exportPending = false;
                    downloadTriggered = false;

                    throw new Error(
                        'The SuiteQL export task failed. ' +
                        'Its output file was removed. ' +
                        'Check NetSuite task status/logs for details.'
                    );
                }

                if (data.complete) {
                    exportFilename = data.filename;
                    return;
                }

                const queued = data.status === 'PENDING';

                setStatus(
                    'exporting',
                    'Step 2 of 4 — Creating CSV',
                    (
                        queued
                            ? 'Waiting for NetSuite to start the export.'
                            : 'NetSuite is creating the CSV in the background.'
                    ) +
                    '\nTask status: ' + data.status +
                    '\nKeep this page open. Download starts automatically.'
                );

                await sleep(2500);
            }
        }

        async function downloadAndDelete() {
            if (!downloadTriggered) {
                if (!exportFilename) {
                    throw new Error(
                        'The server did not return an export filename.'
                    );
                }

                setStatus(
                    'exporting',
                    'Step 3 of 4 — Downloading CSV',
                    'Receiving the completed CSV from NetSuite.' +
                    '\nLarge files may take a little time...'
                );

                const downloadUrl = new URL(
                    ENDPOINT,
                    window.location.origin
                );

                downloadUrl.searchParams.set('action', 'download');

                const response = await fetch(
                    downloadUrl.toString(),
                    {
                        credentials: 'same-origin',
                        cache: 'no-store'
                    }
                );

                if (!response.ok) {
                    throw new Error(
                        'CSV download request failed: HTTP ' +
                        response.status
                    );
                }

                const disposition =
                    response.headers.get('Content-Disposition') || '';

                if (!/attachment/i.test(disposition)) {
                    throw new Error(
                        'The server did not return a downloadable CSV. ' +
                        'Your session may have expired. ' +
                        'The server file has not been deleted.'
                    );
                }

                // Receive the entire CSV before requesting server deletion.
                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);

                const link = document.createElement('a');
                link.href = objectUrl;
                link.download = exportFilename;

                document.body.appendChild(link);
                link.click();
                link.remove();

                downloadTriggered = true;

                setTimeout(() => {
                    URL.revokeObjectURL(objectUrl);
                }, 60000);
            }

            setStatus(
                'exporting',
                'Step 4 of 4 — Cleaning up',
                'Download triggered.' +
                '\nRemoving the temporary CSV from the File Cabinet...'
            );

            await api('delete');

            exportPending = false;
            downloadTriggered = false;

            setStatus(
                'success',
                'Export complete',
                'CSV download triggered successfully.' +
                '\nThe temporary File Cabinet export was deleted.'
            );
        }

        async function exportCsv() {
            if (running || exporting || exportPending) {
                return;
            }

            const sql = el('sqtSql').value.trim();

            if (!sql) {
                setStatus(
                    'error',
                    'SQL required',
                    'Enter a SQL query to export.'
                );
                return;
            }

            exporting = true;
            downloadTriggered = false;
            updateButtons(false);
            startTimer();

            try {
                setStatus(
                    'exporting',
                    'Step 1 of 4 — Preparing export',
                    'Finding or creating the export folder and CSV file.' +
                    '\nSubmitting the native SuiteQL background task...'
                );

                const data = await api('export', {
                    sql: sql
                });

                exportPending = true;
                exportFilename = data.filename;

                setStatus(
                    'exporting',
                    'Step 2 of 4 — Creating CSV',
                    (
                        data.resumed
                            ? 'Resuming the active export for the same SQL.'
                            : 'Export task submitted successfully.'
                    ) +
                    '\nTask ID: ' + data.taskId +
                    '\nWaiting for NetSuite...'
                );

                await waitForExport();
                await downloadAndDelete();
            } catch (e) {
                setStatus(
                    'error',
                    'Export needs attention',
                    e.message +
                    (
                        exportPending
                            ? '\nUse Retry download / cleanup to continue.'
                            : ''
                    )
                );
            } finally {
                exporting = false;
                stopTimer();
                updateButtons(false);
            }
        }

        async function retryDownload() {
            if (running || exporting || !exportPending) {
                return;
            }

            exporting = true;
            updateButtons(false);
            startTimer();

            try {
                setStatus(
                    'exporting',
                    'Resuming export',
                    downloadTriggered
                        ? 'Retrying temporary-file cleanup...'
                        : 'Checking your background export task...'
                );

                if (!downloadTriggered) {
                    await waitForExport();
                }

                await downloadAndDelete();
            } catch (e) {
                setStatus(
                    'error',
                    'Export needs attention',
                    e.message
                );
            } finally {
                exporting = false;
                stopTimer();
                updateButtons(false);
            }
        }

        // -----------------------------------------------------------------
        // EVENTS
        // -----------------------------------------------------------------

        el('sqtSql').addEventListener('input', highlightSql);
        el('sqtSql').addEventListener('scroll', syncSqlScroll);
        window.addEventListener('resize', syncSqlScroll);
        const sqlResizeObserver = new ResizeObserver(syncSqlScroll);
        sqlResizeObserver.observe(el('sqtSql'));

        el('sqtRun').addEventListener('click', () => run(0, true));
        el('sqtExport').addEventListener('click', exportCsv);
        el('sqtRetry').addEventListener('click', retryDownload);

        el('sqtPrevious').addEventListener('click', () => {
            if (results) {
                run(results.pageIndex - 1, false);
            }
        });

        el('sqtNext').addEventListener('click', () => {
            if (results) {
                run(results.pageIndex + 1, false);
            }
        });

        el('sqtGo').addEventListener('click', goToPage);

        el('sqtPageNumber').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                goToPage();
            }
        });

        document.querySelectorAll(
            '#sqt input[name="sqtView"]'
        ).forEach(input => {
            input.addEventListener('change', renderResults);
        });

        el('sqtSql').addEventListener('keydown', event => {
            if (
                (event.ctrlKey || event.metaKey) &&
                event.key === 'Enter'
            ) {
                event.preventDefault();
                event.stopPropagation();
                run(0, true);
            }
        });

        highlightSql();
        updateButtons(true);
    }

    return {
        onRequest: onRequest
    };
});