// Types for the host bridge (window.glazeAPI), shared by the preload and the
// renderer. Local declarations rather than imports from Electron's d.ts so
// renderer code stays typed against what the bridge actually promises — the
// subset the app uses — not against everything Electron could return.

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: (
    | "openFile"
    | "openDirectory"
    | "multiSelections"
    | "showHiddenFiles"
    | "createDirectory"
  )[];
  message?: string;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  message?: string;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface MessageBoxOptions {
  message: string;
  type?: "none" | "info" | "error" | "question" | "warning";
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  title?: string;
  detail?: string;
}

export interface MessageBoxResult {
  response: number;
  checkboxChecked?: boolean;
}

export interface NativeThemeInfo {
  shouldUseDarkColors: boolean;
  themeSource: "system" | "light" | "dark";
}

/** One entry in a native popup menu template. Picking an item resolves the
 *  popup with its commandId; a submenu nests more items. */
export interface PopupMenuItem {
  label?: string;
  type?: "separator" | "normal";
  enabled?: boolean;
  checked?: boolean;
  commandId?: number;
  submenu?: PopupMenuItem[];
}

export interface PopupOptions {
  items?: PopupMenuItem[];
  x?: number;
  y?: number;
}

export interface PopupResult {
  commandId?: number;
}
