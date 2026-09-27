(function () {
  'use strict';
  globalThis.XReviewI18n?.register([
  [
    "取消关注",
    "Unfollow"
  ],
  [
    "返回取关窗口",
    "Return to unfollow window"
  ],
  [
    "手动取关",
    "Manual unfollow"
  ],
  [
    "撤销本地移除",
    "Undo local removal"
  ],
  [
    "停止观察",
    "Stop monitoring"
  ],
  [
    "刷新状态",
    "Refresh status"
  ],
  [
    "正在打开 X 窗口",
    "Opening the X window"
  ],
  [
    "等待核实关注状态",
    "Waiting to verify following status"
  ],
  [
    "请在 X 窗口自行取消关注",
    "Unfollow manually in the X window"
  ],
  [
    "已移除本地记录",
    "Local record removed"
  ],
  [
    "本地记录已保留",
    "Local record retained"
  ],
  [
    "已停止观察",
    "Monitoring stopped"
  ],
  [
    "未能完成观察",
    "Monitoring could not finish"
  ],
  [
    "{status} · {account}",
    "{status} · {account}"
  ],
  [
    "在新窗口中使用 X 原生按钮自行取关，确认状态改变后自动移除本地记录。",
    "Use X’s native controls to unfollow in the new window. The local record is removed after the change is verified."
  ],
  [
    "手动取关同步仅在扩展版的真实名单中可用。",
    "Manual unfollow synchronisation is available only for your real list in the installed extension."
  ],
  [
    "取关观察服务暂时不可用，请重新加载扩展。",
    "Unfollow monitoring is unavailable. Reload the extension."
  ],
  [
    "未授予 X 页面访问权限；账户记录已保留。",
    "X page access was not granted. The account record has been retained."
  ],
  [
    "本地记录已恢复；不会重新关注 X 账户。",
    "The local record has been restored. This does not follow the account again on X."
  ],
  [
    "未覆盖现有记录；不会重新关注 X 账户。",
    "Existing records were not overwritten. This does not follow the account again on X."
  ],
  [
    "设置天数阈值后，逐个复核候选。点击账户行的「取消关注」，按提示允许读取 X 页面，等待检测就绪后在新窗口使用 X 原生按钮自行取关。确认完成后请保留窗口，等待本地记录移除。若之前已经取关但记录仍在，可重新打开该账户；核实当前未关注且记录属于当前登录账户后，会自动同步本地记录，无需重新关注或扫描名单。取消操作、状态不明确或同步前关闭窗口时会保留记录。「撤销本地移除」只恢复本地记录，不会重新关注。名单自动清理及撤销仍在「同步记录」中查看。",
    "Set a day threshold and review candidates individually. Select Unfollow in an account row, allow X page access when prompted, and wait until monitoring is ready before using X’s native controls. Keep the window open after confirming until the local record is removed. If you previously unfollowed but the record remains, reopen that account: once its current non-following state and ownership by the signed-in account are verified, the local record is synchronised without following again or rescanning the list. Cancelling, an uncertain result or closing before synchronisation keeps the record. Undo local removal restores only local data and does not follow the account again. Following-list cleanup and undo remain in Synchronisation history."
  ],
  [
    "此版本免费，不读取 Cookie，也不会代你点击 X 的关注或取关按钮。关注名单收集和发帖时间检查是分别启动的两步。发帖检查须由你点击开始并授予可选的 x.com 网站访问权限；默认最多检查 5,000 个账户，每个账户间隔 3 秒，另需页面加载时间。检查失败、受保护或无法确定日期的账户仍需核实，不会因为没有读到帖子就被判为不活跃。名单收集的进度可在 X 页内查看，其标签页隐藏时会暂停；发帖检查的进度请在控制页查看。名单收集可在弹窗或页内面板停止；发帖检查可在控制页或弹窗停止，关闭或刷新控制页也会停止。清空本地名单会停止运行中的任务。X 限制非 API 自动化，自动滚动及页面分析不等于获得平台许可，也不能保证账号不受限制。",
    "This free version does not read cookies or click X’s follow or unfollow controls for you. Following-list collection and post-date checking are started separately. Post checks require an explicit start and optional x.com site access. By default, a run checks at most 5,000 accounts, with 3 seconds between accounts plus page-load time. Failed checks, protected profiles and uncertain dates require further review; an unreadable timeline is not evidence of inactivity. Following collection shows progress on the X page and pauses when its tab is hidden. Post-check progress appears on the control page. Stop collection from the popup or page panel, and stop post checks from the control page or popup. Closing or refreshing the control page also stops checks. Clearing the local list stops running tasks. X restricts non-API automation. Automated scrolling and page analysis do not imply platform approval or guarantee freedom from account restrictions."
  ]
]);
})();
