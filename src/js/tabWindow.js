/* @flow */
/**
 * Representation of tabbed windows using Immutable.js
 */
import get from 'lodash/get'
import has from 'lodash/has'
import keys from 'lodash/keys'
import intersection from 'lodash/intersection'
import reduce from 'lodash/reduce'
import * as Immutable from 'immutable'

const _ = { get, has, keys, intersection, reduce }

/**
 * Tab state that is persisted as a bookmark
 */
export class SavedTabState extends Immutable.Record({
  bookmarkId: '',
  bookmarkIndex: 0, // position in bookmark folder
  title: '',
  url: ''
}) {
  bookmarkId: string
  bookmarkIndex: number
  title: string
  url: string
}

/**
 * Tab state associated with an open browser tab
 */
export class OpenTabState extends Immutable.Record({
  url: '',
  openTabId: -1,
  active: false,
  openTabIndex: 0, // index of open tab in its window
  favIconUrl: '',
  title: '',
  audible: false,
  pinned: false
}) {
  url: string
  openTabId: number
  active: boolean
  openTabIndex: number
  favIconUrl: string
  title: string
  audible: boolean
  pinned: boolean
}

/**
 * An item in a tabbed window.
 *
 * May be associated with an open tab, a bookmark, or both
 */
export class TabItem extends Immutable.Record({
  saved: false,
  savedState: null, // SavedTabState iff saved

  open: false, // Note: Saved tabs may be closed even when containing window is open
  openState: null // OpenTabState iff open
}) {
  saved: boolean
  savedState: ?SavedTabState
  open: boolean
  openState: ?OpenTabState

  get title (): string {
    if (this.open && this.openState) {
      return this.openState.title
    }

    return this.savedState ? this.savedState.title : ''
  }

  get url (): string {
    if (this.open && this.openState) {
      return this.openState.url
    }

    return (this.savedState ? this.savedState.url : '')
  }

  get pinned (): boolean {
    if (this.open && this.openState) {
      return this.openState.pinned
    }
    return false
  }

  // safe accessor for savedState:
  get safeSavedState (): SavedTabState {
    if (this.saved && this.savedState) {
      return this.savedState
    }
    throw new Error('Unexpected access of savedState on unsaved tab')
  }

  // safe accessor for openState:
  get safeOpenState (): OpenTabState {
    if (this.open && this.openState) {
      return this.openState
    }
    throw new Error('Unexpected access of openState on non-open tab')
  }
}

function tabItemReviver (k, v) {
  if (k === 'savedState') {
    return new SavedTabState(v)
  } else if (k === 'openState') {
    return new OpenTabState(v)
  }
  return v
}

/**
 * convert a JS object to a TabItem
 */
export function tabItemFromJS (js: Object) {
  const tiMap = Immutable.fromJS(js, tabItemReviver)
  return new TabItem(tiMap)
}

/**
 * comparator for sorting tab items
 *
 * NOTE (!!): Only used during initial construction of a saved or open window, because
 * open tab items don't maintain openTabIndex in response to tab events.
 */
export function tabItemCompare (tiA: TabItem, tiB: TabItem): number {
  // open items before non-open items:
  if (tiA.open !== tiB.open) {
    if (tiA.open) {
      return -1
    }
    return 1
  }
  if (tiA.open && tiA.openState && tiB.openState) {
    // both open, use openTabIndex for comparison:
    const ret = tiA.openState.openTabIndex - tiB.openState.openTabIndex
    if (ret === 0) {
      console.warn('unexpected equal openTabIndex vals: ', tiA.toJS(), tiB.toJS())
    }
    return ret
  }
  // both closed and saved, use bookmark index:
  let sret = 0
  if (tiA.savedState && tiB.savedState) {
    sret = tiA.savedState.bookmarkIndex - tiB.savedState.bookmarkIndex
  }
  if (sret === 0) {
    console.warn('unexpected equal bookmarkIndex vals:', tiA.toJS(), tiB.toJS())
  }
  return sret
}

/**
 * Initialize saved tab state from a bookmark
 */
function makeSavedTabState (bm) {
  const url = _.get(bm, 'url', '')
  if (url.length === 0) {
    console.warn('makeSavedTabState: malformed bookmark: missing URL!: ', bm)
  }
  const ts = new SavedTabState({
    url,
    title: _.get(bm, 'title', url),
    bookmarkId: bm.id,
    bookmarkIndex: bm.index
  })
  return ts
}

/**
 * Initialize a TabItem from a bookmark
 *
 * Returned TabItem is closed (not associated with an open tab)
 */
function makeBookmarkedTabItem (bm) {
  const savedState = makeSavedTabState(bm)

  const tabItem = new TabItem({
    saved: true,
    savedState})
  return tabItem
}

/**
 * initialize OpenTabState from a browser tab
 */
function makeOpenTabState (tab) {
  const url = _.get(tab, 'url', '')
  const ts = new OpenTabState({
    url,
    audible: tab.audible,
    favIconUrl: tab.favIconUrl,
    title: _.get(tab, 'title', url),
    openTabId: tab.id,
    active: tab.active,
    openTabIndex: tab.index,
    pinned: tab.pinned
  })
  return ts
}

/**
 * Initialize a TabItem from an open Chrome tab
 */
function makeOpenTabItem (tab) {
  const openState = makeOpenTabState(tab)

  const tabItem = new TabItem({
    open: true,
    openState})
  return tabItem
}

/**
 * Returns the base saved state of a tab item (no open tab info)
 */
export function resetSavedItem (ti: TabItem): TabItem {
  return ti.remove('open').remove('openState')
}

/**
 * Remove components of OpenState that are only relevant while tab
 * is actually open.
 * Used when creating snapshot state for later session restore.
 */
function cleanOpenState (ti: TabItem): TabItem {
  if (!ti.open) {
    return ti
  }
  return ti.update('openState', os => os.remove('openTabId'))
}

/**
 * Return the base state of an open tab (no saved tab info)
 */
function resetOpenItem (ti: TabItem): TabItem {
  return ti.remove('saved').remove('savedState')
}

/**
 * escape table cell for use in Github-Flavored Markdown
 * Since just used on a page title, just rewrite pipes to -s; GFM actually
 * buggy here: https://github.com/gitlabhq/gitlabhq/issues/1238
 */
function escapeTableCell (s: ?string): string {
  if (s && s.indexOf('|') >= 0) {
    return s.replace(/\|/g, '-')
  }
  if (s != null) {
    return s
  }
  return ''
}

/**
 * A TabWindow
 *
 * Tab windows have a title and a set of tab items.
 *
 * A TabWindow has 4 possible states:
 *   (open,!saved)   - An open Chrome window that has not had its tabs saved
 *   (open,saved)    - An open Chrome window that has also had its tabs saved (as bookmarks)
 *   (!open,saved,!snapshot)   - A previously saved window that is not currently
 *                           open and has no snapshot. tabItems will consist solely
 *                           of saved tabs (persisted as boookmarks).
 *
 *   (!open,saved,snapshot) - A previously saved window that is not currently open but
 *                            where tabItems contains the tab state the last time the
 *                            window was open
 */
export class TabWindow extends Immutable.Record({
  saved: false,
  savedTitle: '',
  savedFolderId: '',

  open: false,
  openWindowId: -1,
  windowType: '',
  width: 0,
  height: 0,

  tabItems: Immutable.List(), // <TabItem>

  snapshot: false, // Set if tabItems contains snapshot of last open state
  chromeSessionId: null, // Chrome session id for restore (if found)

  // This is view state, so technically doesn't belong here, but we only have
  // one window component per window right now, we want to be able to toggle
  // this state via a keyboard handler much higher in the hierarchy,
  // and cost to factor out view state would be high.
  expanded: null // tri-state: null, true or false
}) {
  saved: boolean
  savedTitle: string
  savedFolderId: string

  open: boolean
  openWindowId: number
  windowType: string
  width: number
  height: number
  tabItems: Immutable.List<TabItem>
  snapshot: boolean
  chromeSessionId: ?string
  expanded: ?boolean

  get title (): string {
    if (this._title === undefined) {
      this._title = this.computeTitle()
    }

    return this._title
  }

  computeTitle (): string {
    if (this.saved) {
      return this.savedTitle
    }

    const activeTab = this.tabItems.find((t) => t.open && t.openState.active)

    if (!activeTab) {
      // shouldn't happen!
      console.warn('TabWindow.get title(): No active tab found: ', this.toJS())

      var openTabItem = this.tabItems.find((t) => t.open)
      if (!openTabItem) {
        return ''
      }
      return openTabItem.title
    }

    return activeTab.title
  }

  updateSavedTitle (title: string): TabWindow {
    delete this._title
    return this.set('savedTitle', title)
  }

  // get a unique id for this window
  // useful as key in React arrays
  get id (): string {
    if (this._id === undefined) {
      if (this.saved) {
        this._id = '_saved' + this.savedFolderId
      } else {
        this._id = '_open' + this.openWindowId
      }
    }
    return this._id
  }

  get openTabCount (): number {
    return this.tabItems.count((ti) => ti.open)
  }

  /*
   * Returns [index,TabItem] pair if window contains chrome tab id or else undefined
   */
  findChromeTabId (tabId: number): ?([number, TabItem]) {
    return this.tabItems.findEntry((ti) => ti.open &&
      ti.openState && ti.openState.openTabId === tabId)
  }
  /*
   * Returns [index,TabItem] pair if window contains chrome bookmark id or else undefined
   */
  findChromeBookmarkId (bookmarkId: string): ?([number, TabItem]) {
    return this.tabItems.findEntry((ti) => ti.saved &&
      ti.savedState && ti.savedState.bookmarkId === bookmarkId)
  }

  getActiveTabId (): ?string {
    const activeTab = this.tabItems.find((t) => t.open && t.openState.active)
    const tabId = activeTab ? activeTab.openState.openTabId : undefined
    return tabId
  }

  /*
   * set tabItems.
   * Used to sort, but openTabIndex from Chrome isn't maintained by tab updates
   * so we reverted that.
   * Then we briefly used .cacheResult() when tabItems was (supposedly) a Seq,
   * but it turned out that certain code paths (such as inserting a tab) would
   * result in nextItems being a List.
   * Seems to make the most sentence to just make tabItems a List not a Seq
   */
  setTabItems (nextItems: Immutable.List<TabItem>): TabWindow {
    /* HACK: debugging only check; get rid of this! */
    if (!nextItems) {
      console.error('setTabItems: bad nextItems: ', nextItems)
    }
    return this.set('tabItems', nextItems)
  }

  /*
   * get index of an item in this TabWindow
   */
  indexOf (target: TabItem): ?number {
    return this.tabItems.indexOf(target)
  }

  exportStr (): string {
    const fmtTabItem = ti => {
      const urls = (ti.url != null) ? ti.url : ''
      const ret = escapeTableCell(ti.title) + ' | ' + urls + '\n'
      return ret
    }
    const titleStr = '### ' + this.title
    const headerStr = `
Title                                  | URL
---------------------------------------|-----------
`
    const s0 = titleStr + '\n' + headerStr
    const s = this.tabItems.reduce((rs, ti) => rs + fmtTabItem(ti), s0)
    return s
  }

  // combine local expanded state with global expanded state to determine if expanded:
  isExpanded (winStore: any): ?boolean {
    if (this.expanded === null) {
      return (winStore.expandAll && this.open)
    }
    return this.expanded
  }
}

/**
 * Mark window as closed and remove any state (such as openWindowId) only
 * relevant to open windows.
 *
 */
export function removeOpenWindowState (tabWindow: TabWindow,
  snapshot: boolean = true): TabWindow {
  // update tabItems by removing openTabId from any open items:
  const tabItems = tabWindow.tabItems
  let updTabItems
  if (!snapshot) {
    // Not snapshotting, so revert -- only keep saved items,
    // and discard their open state.
    const savedTabItems = tabItems.filter(ti => ti.saved)
    updTabItems = savedTabItems.map(resetSavedItem)
  } else {
    // Snapshot -- leave the tab items untouched and
    // set snapshot to true so that we can restore
    // the window to its previous state when it is re-opened.
    updTabItems = tabItems.map(cleanOpenState)
  }

  return (tabWindow
    .remove('open')
    .remove('openWindowId')
    .remove('windowType')
    .remove('width')
    .remove('height')
    .set('tabItems', updTabItems)
    .set('snapshot', true))
}

/*
 * remove any saved state, keeping only open tab and window state
 *
 * Used when unsave'ing a saved window
 */
export function removeSavedWindowState (tabWindow: TabWindow): TabWindow {
  return tabWindow.remove('saved').remove('savedFolderId').remove('savedTitle')
}

/**
 * Initialize an unopened TabWindow from a bookmarks folder
 */
export function makeFolderTabWindow (bookmarkFolder: any): TabWindow {
  const bmChildren = bookmarkFolder.children
  const itemChildren = bmChildren ? bmChildren.filter((node) => 'url' in node) : []
  const tabItems = Immutable.List(itemChildren.map(makeBookmarkedTabItem))
  var fallbackTitle = ''
  if (bookmarkFolder.title === undefined) {
    console.error('makeFolderTabWindow: malformed bookmarkFolder -- missing title: ', bookmarkFolder)
    if (tabItems.count() > 0) {
      fallbackTitle = tabItems.get(0).title
    }
  }

  const tabWindow = new TabWindow({
    saved: true,
    savedTitle: _.get(bookmarkFolder, 'title', fallbackTitle),
    savedFolderId: bookmarkFolder.id,
    tabItems: tabItems.sort(tabItemCompare)
  })

  return tabWindow
}

/**
 * Initialize a TabWindow from an open Chrome window
 */
export function makeChromeTabWindow (chromeWindow: any): TabWindow {
  const chromeTabs = chromeWindow.tabs ? chromeWindow.tabs : []
  const tabItems = chromeTabs.map(makeOpenTabItem)
  const tabWindow = new TabWindow({
    open: true,
    openWindowId: chromeWindow.id,
    windowType: chromeWindow.type,
    width: chromeWindow.width,
    height: chromeWindow.height,
    tabItems: Immutable.List(tabItems).sort(tabItemCompare)
  })
  return tabWindow
}

/**
 * merge saved and currently open tab states into tab items by joining on URL
 *
 * @param {List<TabItem>} savedItems
 * @param {List<TabItem>} openItems
 *
 * @return {List<TabItem>}
 */
export function mergeSavedOpenTabs (savedItems: Immutable.List<TabItem>,
  openItems: Immutable.List<TabItem>): Immutable.List<TabItem> {
  const openUrlSet = Immutable.Set(openItems.map(ti => ti.url))
  const savedUrlMap = Immutable.Map(savedItems.map(ti => [ti.safeSavedState.url, ti]))

  /*
   * openTabItems for result -- just map over openItems, enriching with saved state if
   * url present in savedUrlMap.
   * Note that we by doing a map on openItems sequence, we preserve the ordering of openItems; this
   * is crucial since openTabIndex isn't maintained in tab update events.
   */
  const openTabItems = openItems.map(openItem => {
    const savedItem = (openItem.openState
      ? savedUrlMap.get(openItem.openState.url, null) : null)
    const mergedItem = savedItem ? openItem.set('saved', true)
      .set('savedState', savedItem.savedState) : openItem
    return mergedItem
  })

  // now grab those saved items that aren't currently open:
  const closedTabItems = savedItems.filter(savedItem =>
    savedItem.savedState && !openUrlSet.has(savedItem.savedState.url))

  const mergedTabItems = openTabItems.concat(closedTabItems)

  return mergedTabItems
}

/**
 * Merge currently open tabs from an open Chrome window with tabItem state of a saved
 * tabWindow
 *
 * @param {List<TabItem>} tabItems -- previous TabItem state
 * @param {[Tab]} openTabs -- currently open tabs from Chrome window
 *
 * @returns {List<TabItem>} TabItems reflecting current window state
 */
function mergeOpenTabs (tabItems, openTabs) {
  const baseSavedItems = tabItems.filter(ti => ti.saved).map(resetSavedItem)
  const chromeOpenTabItems = Immutable.List(openTabs.map(makeOpenTabItem))

  const mergedTabItems = mergeSavedOpenTabs(baseSavedItems, chromeOpenTabItems)

  return mergedTabItems
}

/**
 * re-merge saved and open tab items for a window.
 *
 * Called both after a new tab has been added or URL has changed in an existing tab.
 *
 * @param {TabWindow} tabWindow - TabWindow to be updated
 * @param {Tab|Null} optChromeTab - optional newly created Chrome tab
 * @param {BookmarkTreeNode|Null} optBookmark - optional newly created Chrome bookmark
 */
function mergeTabWindowTabItems (tabWindow, optChromeTab, optBookmark) {
  const tabItems = tabWindow.tabItems

  const baseSavedItems = tabItems.filter(ti => ti.saved).map(resetSavedItem)
  const baseOpenItems = tabItems.filter(ti => ti.open).map(resetOpenItem)

  const updOpenItems = optChromeTab ? baseOpenItems.toList().insert(optChromeTab.index, makeOpenTabItem(optChromeTab)) : baseOpenItems

  const updSavedItems = optBookmark ? baseSavedItems.toList().push(makeBookmarkedTabItem(optBookmark)) : baseSavedItems

  const mergedItems = mergeSavedOpenTabs(updSavedItems, updOpenItems)
  const updWindow = tabWindow.setTabItems(mergedItems)
  return updWindow
}

/**
 * Update a TabWindow by adding a newly created tab
 *
 * @param {TabWindow} tabWindow - TabWindow to be updated
 * @param {Tab} tab - newly created Chrome tab
 */
export function createTab (tabWindow: TabWindow, tab: any): TabWindow {
  return mergeTabWindowTabItems(tabWindow, tab, null)
}

/**
 * Update a TabWindow by adding a saved tab
 * (called when moving saved tabs between windows)
 *
 * @param {TabWindow} tabWindow - TabWindow to be updated
 * @param {Tab} tab - newly created Chrome tab
 */
export function createSavedTab (tabWindow: TabWindow, tab: any, bmNode: any): TabWindow {
  return mergeTabWindowTabItems(tabWindow, tab, bmNode)
}

/**
 * Update a TabWindow by adding a newly created bookmark
 *
 * @param {TabWindow} tabWindow - TabWindow to be updated
 * @param {BookmarkTreeNode} bm - newly created Chrome bookmark
 */
export function createBookmark (tabWindow: TabWindow, bm: any): TabWindow {
  return mergeTabWindowTabItems(tabWindow, null, bm)
}

/**
 * update a TabWindow from a current snapshot of the Chrome Window
 *
 * @param {TabWindow} tabWindow - TabWindow to be updated
 * @param {ChromeWindow} chromeWindow - current snapshot of Chrome window state
 *
 * @return {TabWindow} Updated TabWindow
 */
export function updateWindow (tabWindow: TabWindow, chromeWindow: any): TabWindow {
  const mergedTabItems = mergeOpenTabs(tabWindow.tabItems, chromeWindow.tabs)
  const updWindow = tabWindow
    .setTabItems(mergedTabItems)
    .set('windowType', chromeWindow.type)
    .set('open', true)
    .set('openWindowId', chromeWindow.id)
    .remove('snapshot')
    .remove('chromeSessionId')
  return updWindow
}

/**
 * handle a tab that's been closed
 *
 * @param {TabWindow} tabWindow - tab window with tab that's been closed
 * @param {Number} tabId -- Chrome id of closed tab
 *
 * @return {TabWindow} tabWindow with tabItems updated to reflect tab closure
 */
export function closeTab (tabWindow: TabWindow, tabId: number): TabWindow {
  console.log('TabWindow.closeTab: ', tabWindow.toJS(), tabId)
  const entry = tabWindow.findChromeTabId(tabId)

  if (!entry) {
    console.warn('TabWindow.closeTab: could not find closed tab id ', tabId)
    return tabWindow
  }
  const [index, tabItem] = entry

  var updItems

  if (tabItem.saved) {
    var updTabItem = resetSavedItem(tabItem)
    updItems = tabWindow.tabItems.splice(index, 1, updTabItem)
  } else {
    updItems = tabWindow.tabItems.splice(index, 1)
  }

  return tabWindow.setTabItems(updItems)
}

/**
 * Update a tab's saved state
 *
 * @param {TabWindow} tabWindow - tab window with tab that's been closed
 * @param {TabItem} tabItem -- open tab that has been saved
 * @param {BookmarkTreeNode} tabNode -- bookmark node for saved bookmark
 *
 * @return {TabWindow} tabWindow with tabItems updated to reflect saved state
 */
export function saveTab (tabWindow: TabWindow,
  tabItem: TabItem, tabNode: any): TabWindow {
  const entry = tabWindow.findChromeTabId(tabItem.safeOpenState.openTabId)
  if (!entry) {
    console.error('saveTab: could not find tab id for ', tabItem.toJS(), ' in tabWindow ', tabWindow.toJS())
    return tabWindow
  }
  const [index] = entry

  const savedState = new SavedTabState(tabNode)

  const updTabItem = tabItem.set('saved', true)
    .set('savedState', savedState)

  const updItems = tabWindow.tabItems.splice(index, 1, updTabItem)

  return tabWindow.setTabItems(updItems)
}

/**
 * Update a tab's saved state when tab has been 'unsaved' (i.e. bookmark removed)
 *
 * @param {TabWindow} tabWindow - tab window with tab that's been unsaved
 * @param {TabItem} tabItem -- open tab that has been saved
 *
 * @return {TabWindow} tabWindow with tabItems updated to reflect saved state
 */
export function unsaveTab (tabWindow: TabWindow, tabItem: TabItem) {
  console.log('unsaveTab: ', tabWindow.toJS(), tabItem.toJS())
  const entry = tabWindow.tabItems.findEntry((ti) => ti.saved && ti.safeSavedState.bookmarkId === tabItem.safeSavedState.bookmarkId)
  if (!entry) {
    console.error('unsaveTab: could not find tab id for ', tabItem.toJS(), ' in tabWindow ', tabWindow.toJS())
    return tabWindow
  }
  // Note: We extract sourceTabItem from entry to
  // correctly handle the case of a moved tabItem,
  // where tabItem passed in has already been moved
  var [index, sourceTabItem] = entry
  console.log('unsavedTab: sourceTabItem: ', sourceTabItem.toJS())
  const updTabItem = resetOpenItem(sourceTabItem)
  console.log('unsavedTab: sourceTabItem after reset: ', updTabItem.toJS())

  var updItems
  if (updTabItem.open) {
    updItems = tabWindow.tabItems.splice(index, 1, updTabItem)
  } else {
    // It's neither open nor saved, so just get rid of it...
    updItems = tabWindow.tabItems.splice(index, 1)
  }

  const updWindow = tabWindow.setTabItems(updItems)
  console.log('unsaveTab: updated window: ', updWindow.toJS())
  return updWindow
}

/**
 * Set the active tab in a window to the tab with specified tabId
 *
 * @param {TabWindow} tabWindow -- tab window to be updated
 * @param {tabId} activeTabId - chrome tab id of active tab
 *
 * @return {TabWindow} tabWindow updated with specified tab as active tab.
 */
export function setActiveTab (tabWindow: TabWindow, tabId: number) {
  const tabPos = tabWindow.findChromeTabId(tabId)

  if (!tabPos) {
    console.log('setActiveTab -- tab id not found: ', tabId)
    return tabWindow
  }

  const [index, tabItem] = tabPos
  if (tabItem.active) {
    console.log('setActiveTab: tab was already active, igoring')
    return tabWindow
  }

  // mark all other tabs as not active:
  const tabItemRemoveActive = (ti) => {
    return (ti.open ? ti.set('openState', ti.safeOpenState.remove('active')) : ti)
  }

  const nonActiveItems = tabWindow.tabItems.map(tabItemRemoveActive)

  const updOpenState = tabItem.safeOpenState.set('active', true)
  const updActiveTab = tabItem.set('openState', updOpenState)
  const updItems = nonActiveItems.splice(index, 1, updActiveTab)

  return tabWindow.setTabItems(updItems)
}

/**
 * update a tabItem in a TabWindow to latest chrome tab state
 *
 * May be called with a new or an existing tab
 *
 * @param {TabWindow} tabWindow -- tab window to be updated
 * @param {TabId} tab - chrome tab id
 * @param {changeInfo} object -- fields that have changed in ChromeWindow
 *
 * @return {TabWindow} tabWindow with updated tab state
 */
export function updateTabItem (tabWindow: TabWindow, tabId: number, changeInfo: Object) {
  const tabPos = tabWindow.findChromeTabId(tabId)

  if (!tabPos) {
    // console.warn("updateTabItem: Got update for unknown tab id ", tabId)
    // console.log("updateTabItem: changeInfo: ", changeInfo)
    return tabWindow
  }
  const [index, prevTabItem] = tabPos
  const prevOpenState = prevTabItem.openState
  if (prevOpenState == null) {
    console.error('updateTabItem: unexpected null open state: ', prevTabItem)
    return tabWindow
  }
  const updKeys = _.intersection(_.keys(prevOpenState.toJS()), _.keys(changeInfo))

  if (updKeys.length === 0) {
    return tabWindow
  }
  const updOpenState = _.reduce(updKeys, (acc, k) => acc.set(k, changeInfo[k]), prevOpenState)

  const updTabItem = (updKeys.length > 0) ? prevTabItem.set('openState', updOpenState) : prevTabItem

  // console.log("updateTabItem: ", index, updTabItem.toJS())
  const updItems = tabWindow.tabItems.splice(index, 1, updTabItem)
  const updWindow = tabWindow.setTabItems(updItems)

  if (_.has(changeInfo, 'url')) {
    // May have to split or the updated tabItems -- just re-merge all tabs:
    return mergeTabWindowTabItems(updWindow)
  }
  return updWindow
}

/**
 * update SavedTabState of a tab item in response to a change
 * notification indicating an update to the corresponding bookmark's
 * title or url
 *
 * @param {TabWindow} tabWindow -- tab window to be updated
 * @param {TabItem} tabItem - tab item corresponding to tab
 * @param {changeInfo} object -- fields that have changed in bookmark (title and/or url)
 *
 * @return {TabWindow} tabWindow with updated tab state
 */
export function updateTabBookmark (tabWindow: TabWindow, tabItem: TabItem, changeInfo: Object) {
  const index = tabWindow.indexOf(tabItem)
  if (!index) {
    console.error('tabItem not found in TabWindow: ', tabWindow.toJS(), tabItem.toJS())
    return tabWindow
  }
  const prevTabItem = tabItem
  const prevSavedState = tabItem.savedState
  if (prevSavedState == null) {
    return tabWindow
  }
  const updKeys = _.intersection(_.keys(prevSavedState.toJS()), _.keys(changeInfo))

  if (updKeys.length === 0) {
    return tabWindow
  }
  const updSavedState = _.reduce(updKeys, (acc, k) => acc.set(k, changeInfo[k]), prevSavedState)

  const updTabItem = (updKeys.length > 0) ? prevTabItem.set('savedState', updSavedState) : prevTabItem

  // console.log("updateTabItem: ", index, updTabItem.toJS())
  const updItems = tabWindow.tabItems.splice(index, 1, updTabItem)

  const updWindow = tabWindow.setTabItems(updItems)

  if (_.has(changeInfo, 'url')) {
    // May have to split or the updated tabItems -- just re-merge all tabs:
    return mergeTabWindowTabItems(updWindow)
  }
  return updWindow
}
