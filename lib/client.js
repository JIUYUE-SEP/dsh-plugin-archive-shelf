window.__ModuleLoader__.load({
	id: "dsh-plugin-archive-shelf",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** Dictionary namespace owned by this plugin. */
		const NS = "archive-shelf";

		/** Required client services: the settings seat, the locale registry, and the session list. */
		const inject = ["slots", "locale", "sessions"];

		const CSS = [
			".asx-root{display:flex;flex-direction:column;gap:10px;min-height:100%;font-size:13px;color:var(--dsw-alias-label-primary)}",
			".asx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
			".asx-heading{font-size:14px;font-weight:600}",
			".asx-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px}",
			".asx-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}",
			".asx-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}",
			".asx-btn:disabled{opacity:.45;cursor:default}",
			".asx-btn-danger{color:var(--dsw-alias-state-error-primary)}",
			".asx-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".asx-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);opacity:1}",
			".asx-list{display:flex;flex-direction:column;gap:6px}",
			".asx-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
			".asx-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}",
			".asx-row-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".asx-row-meta{display:flex;flex-wrap:wrap;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".asx-row-path{color:var(--dsw-alias-label-secondary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".asx-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".asx-badge-live{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".asx-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			".asx-row-actions{display:flex;gap:6px;flex-shrink:0}",
			".asx-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary)}",
			".asx-msg{border-radius:6px;padding:7px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-2)}",
			".asx-msg-error{color:var(--dsw-alias-state-error-primary)}",
			".asx-msg-ok{color:var(--dsw-alias-state-success-primary)}",
			".asx-dangling{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary)}",
			".asx-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:80}",
			".asx-dialog{width:440px;max-width:92vw;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}",
			".asx-dialog-title{font-weight:600;font-size:14px}",
			".asx-dialog-body{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}",
			".asx-kv{display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".asx-kv-label{flex-shrink:0;min-width:34px}",
			".asx-kv-value{color:var(--dsw-alias-label-primary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".asx-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}",
		].join("");

		const TAG_ID = "dsh-plugin-archive-shelf/shelf.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-archive-shelf";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const zh = {
			tab: "归档架",
			heading: "归档架",
			hint: "已归档的会话都在这里；还原后会回到它原来所在的工作区与位置。",
			refresh: "刷新",
			loading: "读取中…",
			empty: "还没有归档的会话",
			restore: "还原",
			remove: "彻底删除",
			total: "共 {n} 条",
			live: "运行中",
			resident: "已载入",
			subagent: "子代理",
			untitled: "（无标题）",
			noFile: "文件缺失",
			confirmTitle: "彻底删除这个会话？",
			confirmBody: "将永久删除磁盘上的会话日志，无法恢复。",
			confirmName: "会话",
			confirmId: "ID",
			confirmPath: "目录",
			confirmSize: "占用",
			cancel: "取消",
			confirmDelete: "确认删除",
			deleted: "已删除「{title}」{size}",
			restored: "已还原「{title}」，回到左侧会话列表",
			dangling: "{n} 条归档记录已失效（磁盘上已无对应会话）",
			prune: "清理",
			pruned: "已清理 {n} 条失效记录",
			noRefresh: "浏览器会话列表刷新不可用，已保留失效记录以避免界面残留",
			failedResident: "该会话仍载入在本进程内存中，重启 dsh 后即可删除",
			failedRunning: "该会话正在运行，先停止本轮对话再删除",
			deleteResident: "已载入本进程：重启 dsh 后可删除",
			deleteRunning: "正在运行：先停止本轮对话再删除",
			failed: "操作失败：{error}",
		};
		const en = {
			tab: "Archive Shelf",
			heading: "Archive Shelf",
			hint: "Every archived session; restoring returns it to its workspace and original position.",
			refresh: "Refresh",
			loading: "Loading…",
			empty: "No archived sessions yet",
			restore: "Restore",
			remove: "Delete permanently",
			total: "{n} archived",
			live: "running",
			resident: "loaded",
			subagent: "subagent",
			untitled: "(untitled)",
			noFile: "no files",
			confirmTitle: "Delete this session permanently?",
			confirmBody: "The session log files are removed from disk and cannot be recovered.",
			confirmName: "Session",
			confirmId: "ID",
			confirmPath: "Path",
			confirmSize: "Size",
			cancel: "Cancel",
			confirmDelete: "Delete",
			deleted: "Deleted “{title}” {size}",
			restored: "Restored “{title}” back to the session list",
			dangling: "{n} archived record(s) have no session on disk",
			prune: "Clean up",
			pruned: "Removed {n} stale record(s)",
			noRefresh: "The browser session list could not refresh, so the stale record was kept",
			failedResident: "This session is still loaded in this process; restart dsh, then delete",
			failedRunning: "This session is running a turn; stop it before deleting",
			deleteResident: "Loaded in this process: delete after restarting dsh",
			deleteRunning: "Running a turn: stop it before deleting",
			failed: "Failed: {error}",
		};

		/** Why this row cannot be deleted here, or "" when it can. */
		const blockedReason = (row, t) => {
			if (row.running === true) return t("deleteRunning");
			if (row.live === true) return t("deleteResident");
			return "";
		};

		/** Human copy for one host refusal, keyed on its machine-readable code. */
		const failureText = (result, t) => {
			if (result !== null && typeof result === "object") {
				if (result.code === "running") return t("failedRunning");
				if (result.code === "resident") return t("failedResident");
			}
			return t("failed", { error: String(result !== null && typeof result === "object" ? result.error : result) });
		};

		const formatBytes = (bytes) => {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
			if (bytes < 1024) return bytes + " B";
			if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
			if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
			return (bytes / 1073741824).toFixed(2) + " GB";
		};
		const formatTime = (ms) => {
			if (typeof ms !== "number" || ms <= 0) return "";
			try { return new Date(ms).toLocaleString(); } catch (error) { return ""; }
		};
		const fallbackText = (key, params) => {
			const raw = zh[key] === undefined ? key : zh[key];
			if (params === undefined || params === null) return raw;
			return raw.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
		};

		/** Host route path; kept literal so no injected bootstrap can go missing. */
		const API = "/archive-shelf/api";

		/** One same-origin JSON call to the host half's route. */
		const request = async (payload) => {
			const response = await fetch(API, {
				method: "POST",
				headers: { "content-type": "application/json", "x-archive-shelf-client": "1" },
				body: JSON.stringify(payload),
			});
			return await response.json();
		};

		/**
		 * Client plugin body: one settings section over the archive shelf route.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// A page can carry two live instances of this bundle while a generation is
			// being swapped. The dictionary is identical, so the first registration
			// already serves both — a duplicate must never throw, because a failing
			// client plugin apply takes the whole boot down with it.
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, { zh, en });
				} catch (error) {
					console.warn("[archive-shelf] dictionary already registered by another instance", error);
					return () => {};
				}
			}, "archive-shelf: dictionaries");
			const label = ctx.locale.bind(NS);

			// Dropping an archive entry is only safe once the browser's session list
			// stopped carrying the removed row; otherwise the sidebar would show a
			// row that can no longer be opened.
			const refreshClientList = async () => {
				try {
					await ctx.sessions.refresh();
					return true;
				} catch (error) {
					console.warn("[archive-shelf] session list refresh failed", error);
					return false;
				}
			};

			/**
			 * The archive shelf section: every archived session with its restore and
			 * permanent-delete actions.
			 * @param props - owner props plus the framework seats for a root-scope slot.
			 */
			function ArchiveShelf(props) {
				const h = React.createElement;
				const t = typeof props.t === "function" ? props.t : fallbackText;
				const archivedIds = (typeof props.useWorkspaces === "function")
					? props.useWorkspaces((state) => (state === null || state === undefined ? null : state.archivedSessionIds))
					: null;
				const archiveKey = Array.isArray(archivedIds) ? archivedIds.join(",") : "";
				const [view, setView] = React.useState({ status: "loading", rows: [], dangling: [], error: "" });
				const [notice, setNotice] = React.useState("");
				const [busyId, setBusyId] = React.useState("");
				const [confirmRow, setConfirmRow] = React.useState(null);

				const load = async () => {
					try {
						const result = await request({ action: "list" });
						if (result !== null && typeof result === "object" && result.ok === true) {
							setView({
								status: "ready",
								rows: Array.isArray(result.rows) ? result.rows : [],
								dangling: Array.isArray(result.dangling) ? result.dangling : [],
								error: "",
							});
						} else {
							setView((previous) => Object.assign({}, previous, {
								status: "ready",
								error: t("failed", { error: String(result !== null && typeof result === "object" ? result.error : result) }),
							}));
						}
					} catch (error) {
						setView((previous) => Object.assign({}, previous, {
							status: "ready",
							error: t("failed", { error: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) }),
						}));
					}
				};

				React.useEffect(() => { void load(); }, [archiveKey]);

				const showError = (message) => setView((previous) => Object.assign({}, previous, { error: message }));
				const describe = (error) => String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);

				const restore = async (row) => {
					setBusyId(row.id);
					setNotice("");
					try {
						const result = await request({ action: "unarchive", sessionId: row.id });
						if (result !== null && typeof result === "object" && result.ok === true) {
							setNotice(t("restored", { title: row.title }));
							await load();
						} else {
							showError(failureText(result, t));
						}
					} catch (error) {
						showError(describe(error));
					}
					setBusyId("");
				};

				const remove = async () => {
					const row = confirmRow;
					if (row === null) return;
					setConfirmRow(null);
					setBusyId(row.id);
					setNotice("");
					try {
						const result = await request({ action: "delete", sessionId: row.id, confirm: true });
						if (result !== null && typeof result === "object" && result.ok === true) {
							if (await refreshClientList()) {
								try { await request({ action: "forget", sessionId: row.id }); } catch (error) { console.warn("[archive-shelf] stale record cleanup failed", error); }
								const size = formatBytes(result.freedBytes);
								setNotice(t("deleted", { title: row.title, size: size === "" ? "" : "（" + size + "）" }));
							} else {
								setNotice(t("noRefresh"));
							}
							await load();
						} else {
							showError(failureText(result, t));
						}
					} catch (error) {
						showError(describe(error));
					}
					setBusyId("");
				};

				const prune = async () => {
					const ids = view.dangling.slice();
					if (ids.length === 0) return;
					setBusyId("*");
					setNotice("");
					if (!(await refreshClientList())) {
						showError(t("noRefresh"));
						setBusyId("");
						return;
					}
					let removed = 0;
					for (const id of ids) {
						try {
							const result = await request({ action: "forget", sessionId: id });
							if (result !== null && typeof result === "object" && result.ok === true) removed += 1;
						} catch (error) {
							console.warn("[archive-shelf] stale record cleanup failed", error);
						}
					}
					setNotice(t("pruned", { n: removed }));
					await load();
					setBusyId("");
				};

				const rowNode = (row) => {
					const meta = [];
					if (row.workspace !== "") meta.push(h("span", { key: "w" }, row.workspace));
					if (row.createdAt > 0) meta.push(h("span", { key: "t" }, formatTime(row.createdAt)));
					if (typeof row.sizeBytes === "number") meta.push(h("span", { key: "s" }, formatBytes(row.sizeBytes)));
					if (row.subagent === true) meta.push(h("span", { key: "a", className: "asx-badge" }, t("subagent")));
					if (row.running === true) meta.push(h("span", { key: "l", className: "asx-badge asx-badge-live" }, t("live")));
					else if (row.live === true) meta.push(h("span", { key: "l", className: "asx-badge" }, t("resident")));
					if (row.onDisk !== true) meta.push(h("span", { key: "n", className: "asx-badge asx-badge-warn" }, t("noFile")));
					const main = h("div", { className: "asx-row-main" }, [
						h("div", { className: "asx-row-title", key: "title" }, row.title === "" ? t("untitled") : row.title),
						h("div", { className: "asx-row-meta", key: "meta" }, meta),
						h("div", { className: "asx-row-path", key: "path" }, row.cwd === "" ? row.id : row.cwd),
					]);
					const actions = h("div", { className: "asx-row-actions" }, [
						h("button", {
							key: "restore",
							type: "button",
							className: "asx-btn",
							disabled: busyId !== "",
							onClick: () => { void restore(row); },
						}, t("restore")),
						h("button", {
							key: "delete",
							type: "button",
							className: "asx-btn asx-btn-danger",
							disabled: busyId !== "" || blockedReason(row, t) !== "",
							title: blockedReason(row, t) === "" ? undefined : blockedReason(row, t),
							onClick: () => { setNotice(""); setConfirmRow(row); },
						}, t("remove")),
					]);
					return h("div", { className: "asx-row", key: row.id }, [main, actions]);
				};

				const children = [];
				children.push(h("div", { className: "asx-head", key: "head" }, [
					h("div", { key: "text" }, [
						h("div", { className: "asx-heading", key: "h" }, t("heading") + " · " + t("total", { n: view.rows.length })),
						h("div", { className: "asx-hint", key: "hint" }, t("hint")),
					]),
					h("button", {
						key: "refresh",
						type: "button",
						className: "asx-btn",
						disabled: busyId !== "",
						onClick: () => { void load(); },
					}, t("refresh")),
				]));

				if (view.error !== "") children.push(h("div", { className: "asx-msg asx-msg-error", key: "error" }, view.error));
				if (notice !== "") children.push(h("div", { className: "asx-msg asx-msg-ok", key: "notice" }, notice));

				if (view.status === "loading") {
					children.push(h("div", { className: "asx-empty", key: "loading" }, t("loading")));
				} else if (view.rows.length === 0) {
					children.push(h("div", { className: "asx-empty", key: "empty" }, t("empty")));
				} else {
					children.push(h("div", { className: "asx-list", key: "list" }, view.rows.map(rowNode)));
				}

				if (view.dangling.length > 0) {
					children.push(h("div", { className: "asx-msg asx-dangling", key: "dangling" }, [
						h("span", { key: "t" }, t("dangling", { n: view.dangling.length })),
						h("button", {
							key: "prune",
							type: "button",
							className: "asx-btn",
							disabled: busyId !== "",
							onClick: () => { void prune(); },
						}, t("prune")),
					]));
				}

				if (confirmRow !== null) {
					const size = formatBytes(confirmRow.sizeBytes);
					const lines = [
						h("div", { className: "asx-dialog-title", key: "title" }, t("confirmTitle")),
						h("div", { className: "asx-dialog-body", key: "body" }, t("confirmBody")),
						h("div", { className: "asx-kv", key: "name" }, [
							h("span", { className: "asx-kv-label", key: "l" }, t("confirmName")),
							h("span", { className: "asx-kv-value", key: "v" }, confirmRow.title),
						]),
						h("div", { className: "asx-kv", key: "id" }, [
							h("span", { className: "asx-kv-label", key: "l" }, t("confirmId")),
							h("span", { className: "asx-kv-value", key: "v" }, confirmRow.id),
						]),
						h("div", { className: "asx-kv", key: "path" }, [
							h("span", { className: "asx-kv-label", key: "l" }, t("confirmPath")),
							h("span", { className: "asx-kv-value", key: "v" }, confirmRow.cwd === "" ? confirmRow.id : confirmRow.cwd),
						]),
						size === "" ? null : h("div", { className: "asx-kv", key: "size" }, [
							h("span", { className: "asx-kv-label", key: "l" }, t("confirmSize")),
							h("span", { className: "asx-kv-value", key: "v" }, size),
						]),
						h("div", { className: "asx-dialog-actions", key: "actions" }, [
							h("button", { key: "cancel", type: "button", className: "asx-btn", onClick: () => setConfirmRow(null) }, t("cancel")),
							h("button", { key: "ok", type: "button", className: "asx-btn asx-btn-primary", onClick: () => { void remove(); } }, t("confirmDelete")),
						]),
					];
					children.push(h("div", { className: "asx-mask", key: "mask", onClick: () => setConfirmRow(null) }, [
						h("div", { className: "asx-dialog", key: "dialog", onClick: (event) => event.stopPropagation() }, lines),
					]));
				}

				return h("div", { className: "asx-root" }, children);
			}

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archive-shelf",
				order: 30,
				label: () => label("tab"),
				locale: NS,
			}, ArchiveShelf));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
