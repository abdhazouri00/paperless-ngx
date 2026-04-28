import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { RouterModule, ActivatedRoute, Router } from '@angular/router'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { NgxBootstrapIconsModule } from 'ngx-bootstrap-icons'
import { Subject } from 'rxjs'
import { first, takeUntil } from 'rxjs/operators'

import { Folder } from 'src/app/data/folder'
import { Document } from 'src/app/data/document'
import { FILTER_FOLDER } from 'src/app/data/filter-rule-type'
import { FolderService } from 'src/app/services/rest/folder.service'
import { DocumentService } from 'src/app/services/rest/document.service'
import { ToastService } from 'src/app/services/toast.service'
import { PageHeaderComponent } from '../common/page-header/page-header.component'
import { DocumentTitlePipe } from 'src/app/pipes/document-title.pipe'
import { PermissionsDialogComponent } from '../common/permissions-dialog/permissions-dialog.component'
import { TagComponent } from '../common/tag/tag.component'

@Component({
  selector: 'pngx-folder-explorer',
  templateUrl: './folder-explorer.component.html',
  styleUrls: ['./folder-explorer.component.scss'],
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    NgxBootstrapIconsModule,
    PageHeaderComponent,
    DocumentTitlePipe,
    TagComponent,
  ],
})
export class FolderExplorerComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute)
  private router = inject(Router)
  private folderService = inject(FolderService)
  private documentService = inject(DocumentService)
  private toastService = inject(ToastService)
  private modalService = inject(NgbModal)

  private destroy$ = new Subject<void>()

  currentFolderId: number | null = null
  currentFolder: Folder | null = null
  breadcrumbs: Folder[] = []

  subfolders: Folder[] = []
  documents: Document[] = []
  documentCount = 0

  loadingFolders = false
  loadingDocs = false

  // Context menu
  contextMenu: { x: number; y: number; folder: Folder | null } | null = null

  // Inline rename
  editingFolder: Folder | null = null
  editingName = ''

  // Inline create
  isCreating = false
  newFolderName = ''

  ngOnInit() {
    this.route.params.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      this.currentFolderId = params['id'] ? +params['id'] : null
      this.load()
    })
  }

  ngOnDestroy() {
    this.destroy$.next()
    this.destroy$.complete()
  }

  load() {
    this.loadingFolders = true
    this.loadingDocs = true
    this.subfolders = []
    this.documents = []
    this.breadcrumbs = []
    this.currentFolder = null

    // Load subfolders using list() — listAll() caches and ignores params on repeat calls
    this.folderService
      .list(1, 1000, 'name', false, this.currentFolderId ? { parent: this.currentFolderId } : {})
      .pipe(first())
      .subscribe({
        next: (result) => {
          this.subfolders = result.results
          this.loadingFolders = false
        },
        error: () => { this.loadingFolders = false },
      })

    if (this.currentFolderId) {
      // Get current folder, then iteratively walk parents for breadcrumbs
      this.folderService
        .get(this.currentFolderId)
        .pipe(first())
        .subscribe((folder) => {
          this.currentFolder = folder
          this.loadBreadcrumbs(folder)
        })

      // Load documents
      this.documentService
        .listFiltered(1, 50, '-created', false, [
          { rule_type: FILTER_FOLDER, value: this.currentFolderId.toString() },
        ])
        .pipe(first())
        .subscribe({
          next: (result) => {
            this.documents = result.results
            this.documentCount = result.count
            this.loadingDocs = false
          },
          error: () => { this.loadingDocs = false },
        })
    } else {
      this.loadingDocs = false
    }
  }

  /**
   * Walk up the parent chain iteratively via individual GET calls.
   * Sets this.breadcrumbs once the full chain is resolved.
   */
  private loadBreadcrumbs(folder: Folder): void {
    const crumbs: Folder[] = [folder]
    const fetchParent = (parentId: number) => {
      this.folderService.get(parentId).pipe(first()).subscribe({
        next: (parent) => {
          crumbs.unshift(parent)
          if (parent.parent) {
            fetchParent(parent.parent)
          } else {
            this.breadcrumbs = crumbs
          }
        },
        error: () => {
          // Partial breadcrumb is better than none
          this.breadcrumbs = crumbs
        },
      })
    }
    if (folder.parent) {
      fetchParent(folder.parent)
    } else {
      this.breadcrumbs = crumbs
    }
  }

  openFolder(folder: Folder) {
    this.router.navigate(['/folders', folder.id])
  }

  openDocument(doc: Document) {
    this.router.navigate(['/documents', doc.id])
  }

  // ── Context menu ───────────────────────────────────────────────────────────

  onFolderRightClick(event: MouseEvent, folder: Folder) {
    event.preventDefault()
    event.stopPropagation()
    this.contextMenu = { x: event.clientX, y: event.clientY, folder }
  }

  onAreaRightClick(event: MouseEvent) {
    event.preventDefault()
    this.contextMenu = { x: event.clientX, y: event.clientY, folder: null }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(_event: MouseEvent) {
    this.contextMenu = null
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.contextMenu = null
    this.cancelCreate()
    this.cancelEdit()
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  startCreate() {
    this.contextMenu = null
    this.cancelEdit()
    this.isCreating = true
    this.newFolderName = ''
    setTimeout(() => document.getElementById('new-folder-input')?.focus())
  }

  confirmCreate() {
    const name = this.newFolderName.trim()
    if (!name) { this.cancelCreate(); return }
    const payload: Partial<Folder> = { name }
    if (this.currentFolderId) payload.parent = this.currentFolderId

    this.folderService.create(payload as Folder).pipe(first()).subscribe({
      next: () => {
        this.isCreating = false
        this.newFolderName = ''
        this.folderService.clearCache()
        this.load()
      },
      error: () => this.toastService.showError($localize`Error creating folder`),
    })
  }

  cancelCreate() {
    this.isCreating = false
    this.newFolderName = ''
  }

  // ── Rename ─────────────────────────────────────────────────────────────────

  startEdit(folder: Folder) {
    this.contextMenu = null
    this.cancelCreate()
    this.editingFolder = folder
    this.editingName = folder.name
    setTimeout(() => {
      const el = document.getElementById(`edit-input-${folder.id}`) as HTMLInputElement
      el?.select()
    })
  }

  confirmEdit() {
    const name = this.editingName.trim()
    if (!name || !this.editingFolder) { this.cancelEdit(); return }
    this.folderService.patch({ ...this.editingFolder, name } as Folder).pipe(first()).subscribe({
      next: () => {
        this.editingFolder = null
        this.folderService.clearCache()
        this.load()
      },
      error: () => this.toastService.showError($localize`Error renaming folder`),
    })
  }

  cancelEdit() {
    this.editingFolder = null
    this.editingName = ''
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteFolder(folder: Folder) {
    this.contextMenu = null
    if (!confirm($localize`Delete folder "${folder.name}"? Sub-folders will also be deleted. Documents will remain but lose their folder assignment.`))
      return

    this.folderService.delete(folder).pipe(first()).subscribe({
      next: () => {
        this.folderService.clearCache()
        folder.id === this.currentFolderId
          ? this.router.navigate(['/folders'])
          : this.load()
      },
      error: () => this.toastService.showError($localize`Error deleting folder`),
    })
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  editPermissions(folder: Folder) {
    this.contextMenu = null
    const modal = this.modalService.open(PermissionsDialogComponent, { backdrop: 'static' })
    const dialog = modal.componentInstance as PermissionsDialogComponent
    dialog.object = folder
    modal.componentInstance.confirmClicked.pipe(first()).subscribe(({ permissions }) => {
      modal.componentInstance.buttonsEnabled = false
      const updated = { ...folder } as any
      updated.owner = permissions['owner']
      updated['set_permissions'] = permissions['set_permissions']
      this.folderService.patch(updated).pipe(first()).subscribe({
        next: () => {
          this.toastService.showInfo($localize`Folder permissions updated`)
          modal.close()
          this.load()
        },
        error: (e) => this.toastService.showError($localize`Error updating permissions`, e),
      })
    })
  }
}
