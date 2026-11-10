# SuiteQL Run and Export

A NetSuite SuiteScript 2.1 Suitelet for running SuiteQL queries, previewing results, and exporting CSV files. No external libraries required.

## Features

- SuiteQL editor with syntax highlighting and Ctrl/Cmd+Enter to run.
- Preview up to 5,000 rows, or use pagination with 1,000 rows per page.
- Switch between table and CSV previews without rerunning the query.
- Export through NetSuite's native asynchronous `SUITE_QL` task.
- Export progress, elapsed timer, and download/cleanup retry.
- Unique temporary files, renamed after task completion for download.

## Deployment

1. Enable **SuiteScript** and **SuiteAnalytics Workbook** in your NetSuite account.
2. Upload [suiteql-run-and-export.js](./suiteql-run-and-export.js) to the File Cabinet, preferably under **SuiteScripts**.
3. Create a **Suitelet** script record using the uploaded file and create a deployment.
4. Set **Status** to **Released** and **Execute as Role** to **Current Role**.
5. Add the intended users or roles to the deployment's **Audience**.
6. Keep **Available Without Login** disabled and open the deployment's internal URL.

Test in a sandbox before deploying to production.

## User Permissions

Configure these on the user's role:

| Permission | Tab | Level |
|---|---|---|
| SuiteAnalytics Workbook | Reports | Edit |
| Documents and Files | Lists | Full |
| Records referenced by the query | Lists / Transactions / Custom Record | View or higher |

Users also need access to the Suitelet deployment and export folder. **Documents and Files: Full** is needed because the tool deletes temporary CSV files. Queries run with the current role's data permissions and restrictions.

## Usage

1. Enter a SuiteQL query and click **Run**.
2. Optionally enable **Paginated preview**. Use a unique, stable `ORDER BY`; each page request executes the query again.
3. Click **Export full CSV** to export the SQL currently in the editor.
4. Keep the page open until the download starts and cleanup finishes. If interrupted by an error, use **Retry download / cleanup**.

Exports use the root File Cabinet folder:

```text
NETSUITE SUITEQL run and export tool
```

The folder is created automatically if missing. Completed downloads use:

```text
<folder name>_<last 20 characters of task ID>.csv
```

The temporary server file is deleted after the browser receives the CSV and the download is triggered. Only one export per session is supported; NetSuite platform limits still apply. Closing the page may leave temporary files requiring administrator cleanup after the task has stopped.

Folder name and preview page size can be changed in `CONFIG` in [suiteql-run-and-export.js](./suiteql-run-and-export.js).

---

**Author:** [Eric Pinel](https://www.linkedin.com/in/eric-pinel-5a9820248/)  
**License:** MIT - Copyright (c) 2026 Eric Pinel.
