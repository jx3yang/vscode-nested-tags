import { debounce } from "debounce";
import * as fs from "fs";
import * as vscode from "vscode";
import { setsAreEqual } from "./sets";
import { FileNode, fileNodeSort } from "./tag-tree/file-node";
import { TagNode, tagNodeSort } from "./tag-tree/tag-node";
import { TagTree } from "./tag-tree/tag-tree";
import * as grayMatter from "gray-matter";
import { Uri } from "vscode";
import * as path from "path";

interface IFileInfo {
  tags: Set<string>;
  filePath: string;
  title?: string;
}

class TagTreeDataProvider
  implements vscode.TreeDataProvider<TagNode | FileNode> {
  private tagTree: TagTree;
  // Responsible for notifying the TreeDataProvider to update for the specified element in tagTree
  private _onDidChangeTreeData: vscode.EventEmitter<
    TagNode | FileNode | null
  > = new vscode.EventEmitter<TagNode | FileNode | null>();
  /*
   * An optional event to signal that an element or root has changed.
   * This will trigger the view to update the changed element/root and its children recursively (if shown).
   * To signal that root has changed, do not pass any argument or pass undefined or null.
   */
  readonly onDidChangeTreeData: vscode.Event<TagNode | FileNode | null> = this
    ._onDidChangeTreeData.event;

  private getDisplayName(info: IFileInfo): string {
    return info.title ?? this.getPathRelativeToWorkspaceFolder(Uri.file(info.filePath));
  }

  constructor() {
    /* Register the extension to events of interest
     * Debounce to improve performance. Otherwise a file read would occur during each of the user's changes to the document.
     */
    vscode.workspace.onDidChangeTextDocument(
      debounce(
        (e: vscode.TextDocumentChangeEvent) => this.onDocumentChanged(e),
        500
      )
    );
    vscode.workspace.onWillSaveTextDocument(e => {
      this.onWillSaveTextDocument(e);
    });

    // @ts-ignore
    const additionalFileTypes: string[] = vscode.workspace
      .getConfiguration()
      .get("vscode-nested-tags.additionalFileTypes");
    const customGlobPattern =
      additionalFileTypes.length > 0 ? `,${additionalFileTypes.join(",")}` : "";
    const globPattern = `{md${customGlobPattern}}`;

    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    fileWatcher.onDidDelete((...args) => this.onDidDelete(...args));
    fileWatcher.onDidCreate((...args) => this.onDidCreate(...args));

    this.tagTree = new TagTree();

    /*
     * Add all files in the current workspace folder to the tag tree
     */
    (async () => {
      const uris = await vscode.workspace.findFiles(`**/*.${globPattern}`);
      const infos = await Promise.all(
        uris.map(uri => this.getFileInfoFromFileOnFileSystem(uri.fsPath))
      );
      infos
        .filter(info => info.tags.size > 0)
        .forEach(info => {
          const displayName = this.getDisplayName(info);

          this.tagTree.addFile(info.filePath, [...info.tags], displayName);
        });

      this._onDidChangeTreeData.fire();
    })();
  }

  /**
   * Required for implementing TreeDataProvider interface.
   *
   * @param {(TagNode | FileNode)} element
   * @returns
   * @memberof TagTreeDataProvider
   */
  public getChildren(element: TagNode | FileNode) {
    if (element instanceof FileNode) {
      return [];
    } else if (element === undefined) {
      // Convert the tags and files sets to arrays, then sort the arrays add tags first, then files
      const children = [
        ...[...this.tagTree.root.tags.values()].sort(tagNodeSort),
        ...[...this.tagTree.root.files.values()].sort(fileNodeSort)
      ];

      return children;
    } else {
      const children = [
        ...[...element.tags.values()].sort(tagNodeSort),
        ...[...element.files.values()].sort(fileNodeSort)
      ];

      return children;
    }
  }

  /**
   * Required for implementing TreeDataProvider interface.
   *
   * @param {(TagNode | FileNode)} element
   * @returns {vscode.TreeItem}
   * @memberof TagTreeDataProvider
   */
  public getTreeItem(element: TagNode | FileNode): vscode.TreeItem {
    const tagTreeNode = this.tagTree.getNode(element.pathToNode);
    const { displayName } = tagTreeNode;
    const isFile = tagTreeNode instanceof FileNode;

    const collapsibleState = isFile
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;

    const result = new vscode.TreeItem(displayName, collapsibleState);
    if (isFile) {
      result.command = {
        arguments: [vscode.Uri.file((tagTreeNode as FileNode).filePath)],
        command: "vscode.open",
        title: "Jump to tag reference"
      };
    }
    return result;
  }

  /**
   * Update the ui view if the document that is about to be saved has a different set of tags than
   * what is located in the currentState of the tag tree. This keeps the tree view in sync with
   * any changes to tags for a document before saving.
   * @param changeEvent
   */
  private async onWillSaveTextDocument(
    changeEvent: vscode.TextDocumentWillSaveEvent
  ): Promise<void> {
    if (
      changeEvent.document.isDirty &&
      this.matchesWatchedFileExtensions(changeEvent.document.uri)
    ) {
      const filePath = changeEvent.document.fileName;
      const fileInfo = await this.getFileInfoFromFileOnFileSystem(filePath);
      const tagsInTreeForFile = this.tagTree.getTagsForFile(filePath);
      // @ts-ignore
      this.updateTreeForFile(filePath, fileInfo, tagsInTreeForFile, fileInfo.tags);
    }
  }

  /**
   * Updates the tagTree and the ui tree view upon _every_ _single_ _change_ (saved or unsaved)
   * to a document. This method helps to keep the tag contents of the document in sync with the
   * tag tree view in the UI. This method fires for documents that have already been written to
   * the file system or are still in memory.
   *
   * @param changeEvent
   */
  private onDocumentChanged(changeEvent: vscode.TextDocumentChangeEvent): void {
    const filePath = changeEvent.document.fileName;
    // If the file has been saved and the file is a watched file type allow for making changes to the tag tree
    if (
      filePath !== undefined &&
      this.matchesWatchedFileExtensions(changeEvent.document.uri)
    ) {
      const fileInfo = this.getFileInfoFromFileText(
        changeEvent.document.getText(),
        filePath
      );
      const tagsInTreeForFile = this.tagTree.getTagsForFile(filePath);
      const currentTitle = this.tagTree.getDisplayNameForFile(filePath);
      const isUpdateNeeded = !setsAreEqual(fileInfo.tags, tagsInTreeForFile) || fileInfo.title != currentTitle;
      /*
       * This could be potentially performance intensive due to the number of changes that could
       * be made to a document and how large the document is. There will definitely need to be some
       * work done around TagTree to make sure that the code is performant.
       */
      if (isUpdateNeeded) {
        this.tagTree.deleteFile(filePath);
        const displayName = this.getDisplayName(fileInfo);
        this.tagTree.addFile(
          filePath,
          [...fileInfo.tags.values()],
          displayName
        );
        // TODO: (bdietz) - this._onDidChangeTreeData.fire(specificNode?)
        this._onDidChangeTreeData.fire();
      }
    }
  }

  private async onDidDelete(fileUri: vscode.Uri) {
    // I'm not sure if it matters whether or not the item is attempted to be deleted
    this.tagTree.deleteFile(fileUri.fsPath);
    this._onDidChangeTreeData.fire();
  }

  private async onDidCreate(fileUri: vscode.Uri) {
    if (!fs.lstatSync(fileUri.fsPath).isDirectory()) {
      const fileInfo = await this.getFileInfoFromFileOnFileSystem(fileUri.fsPath);
      const displayName = this.getDisplayName(fileInfo);
      this.tagTree.addFile(
        fileUri.fsPath,
        [...fileInfo.tags.values()],
        displayName
      );
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   *
   * @param filePath The uri path to the file
   * @param tagsBefore The tags before a change to the document
   * @param tagsAfter The tags after a change to the document
   */
  private updateTreeForFile(
    filePath: string,
    fileInfo: IFileInfo,
    tagsBefore: Set<string>,
    tagsAfter: Set<string>
  ) {
    const isUpdateNeeded = !setsAreEqual(tagsBefore, tagsAfter);
    if (isUpdateNeeded) {
      this.tagTree.deleteFile(filePath);
      const displayName = this.getDisplayName(fileInfo);
      this.tagTree.addFile(filePath, [...tagsAfter.values()], displayName);
      /*
       * TODO (bdietz) - this._onDidChangeTreeData.fire(specificNode?)
       * specifying the specific node would help to improve the efficiency of the tree refresh.
       * Right now null/undefined being passed in fires off a refresh for the root of the tag tree.
       * I wonder if all the parents that have been impacted should be returned from the tag tree
       * for a fileDelete.
       */
      this._onDidChangeTreeData.fire();
    }
  }

  // TODO: (bdietz) - the method names of getTagsFrom* are kind of misleading because they return a FileInfo object.

  private getFileInfoFromFileText(
    fileContents: string,
    filePath: string
  ): IFileInfo {
    const { data } = grayMatter(fileContents);
    const yamlTags = new Set<string>(data.tags ? [data.tags] : []);
    const { title } = data as { title?: string };
    return fileContents.split("\n").reduce(
      (accumulator, currentLine) => {
        if (currentLine.includes("@nested-tags:")) {
          // @ts-ignore
          const tagsToAdd = currentLine
            .split("@nested-tags:")
            .pop()
            // Do some best effort cleanup on common multi-line comment closing syntax
            .replace("-->", "")
            .replace("*/", "")
            .split(",");
          return {
            ...accumulator,
            tags: new Set([...accumulator.tags, ...tagsToAdd]),
          };
        }

        return accumulator;
      },
      // @ts-ignore
      { tags: new Set(...yamlTags), filePath, title }
    );
  }

  /**
   * Retrieves tags for a file on the file system.
   *
   * @param filePath The local filesystem path
   */
  private async getFileInfoFromFileOnFileSystem(
    filePath: string
  ): Promise<IFileInfo> {
    const buffer = await fs.promises.readFile(filePath);
    return this.getFileInfoFromFileText(buffer.toString(), filePath);
  }

  /**
   *
   * @param uri
   */
  private getPathRelativeToWorkspaceFolder(uri: Uri): string {
    const currentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath =
      typeof currentWorkspaceFolder !== "undefined"
        ? path.relative(currentWorkspaceFolder.uri.path, uri.path)
        : uri.path;

    return relativePath;
  }

  /**
   * Checks to see if a given file uri matches the file extensions that are user configured.
   *
   * @param uri
   */
  private matchesWatchedFileExtensions(uri: Uri) {
    const supportedFileExtensions = new Set([
      "md",
      // @ts-ignore
      ...vscode.workspace
        .getConfiguration()
        .get("vscode-nested-tags.additionalFileTypes")
    ]);

    const fileExtension = uri.fsPath.split(".").pop();

    return supportedFileExtensions.has(fileExtension);
  }
}

export { TagTreeDataProvider };
