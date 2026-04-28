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
import { first, switchMap, takeUntil } from 'rxjs/operators'

import { Folder } from 'src/app/data/folder'
import { Document } from 'src/app/data/document'
import { FILTER_FOLDER } from 'src/app/data/filter-rule-type'
import { FolderService } from 'src/app/services/rest/folder.service'
import { DocumentService } from 'src/app/services/rest/document.service'
import { ToastService } from 'src/app/services/toast.service'
import { PageHeaderComponent } from '../common/page-header/page-header.component'
import { DocumentTitlePipe } from 'src/app/pipes/document-title.pipe'

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
  ],
})
export class FolderExplorerComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute)
  private router = inject(Router)
  private folderService = inject(FolderService)
  private documentService = inject(DocumentService)
  private toastService = inject(ToastService)

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
  contextMenu: {
    x: number
    y: number
    folder: Folder | null
  } | null = null

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

    // Load subfolders: default API returns root when no param, ?parent=id for children
    const folderParams: Record<string, any> = this.currentFolderId
      ? { parent: this.currentFolderId }
      : {}

    this.folderService
      .listAll(null, null, folderParams)
      .pipe(first())
      .subscribe({
        next: (result) => {
          this.subfolders = result.results.filter((f) =>
            this.currentFolderId
              ? f.parent === this.currentFolderId
              : !f.parent
          )
          this.loadingFolders = false
        },
        error: () => {
          this.loadingFolders = false
        },
      })

    if (this.currentFolderId) {
      // Load current folder details + build breadcrumb chain
      this.folderService
        .get(this.currentFolderId)
        .pipe(first())
        .subscribe((folder) => {
          this.currentFolder = folder
          this.buildBreadcrumbs(folder)
        })

      // Load documents in this folder
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
          error: () => {
            this.loadingDocs = false
          },
        })
    } else {
      this.loadingDocs = false
    }
  }

  private buildBreadcrumbs(folder: Folder) {
    // Walk the full_path to build breadcrumb: /Root/Sub/Deep → ['Root','Sub','Deep']
    // We load a flat list and walk parent IDs
    this.folderService
      .listAll(null, null, { parent: 'all' })
      .pipe(first())
      .subscribe((result) => {
        const all = result.results
        const crumbs: Folder[] = []
        let node: Folder | undefined = folder
        while (node) {
          crumbs.unshift(node)
          node = node.parent ? all.find((f) => f.id === node!.parent) : undefined
        }
        this.breadcrumbs = crumbs
      })
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
  onDocumentClick(event: MouseEvent) {
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
    // Focus the input next tick
    setTimeout(() => {
      const el = document.getElementById('new-folder-input')
      el?.focus()
    })
  }

  confirmCreate() {
    const name = this.newFolderName.trim()
    if (!name) {
      this.cancelCreate()
      return
    }
    const payload: Partial<Folder> = { name }
    if (this.currentFolderId) payload.parent = this.currentFolderId

    this.folderService
      .create(payload as Folder)
      .pipe(first())
      .subscribe({
        next: () => {
          this.isCreating = false
          this.newFolderName = ''
          this.folderService.clearCache()
          this.load()
        },
        error: () =>
          this.toastService.showError($localize`Error creating folder`),
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
      const el = document.getElementById(`edit-input-${folder.id}`)
      if (el) {
        ;(el as HTMLInputElement).select()
      }
    })
  }

  confirmEdit() {
    const name = this.editingName.trim()
    if (!name || !this.editingFolder) {
      this.cancelEdit()
      return
    }
    this.folderService
      .patch({ ...this.editingFolder, name } as Folder)
      .pipe(first())
      .subscribe({
        next: () => {
          this.editingFolder = null
          this.folderService.clearCache()
          this.load()
        },
        error: () =>
          this.toastService.showError($localize`Error renaming folder`),
      })
  }

  cancelEdit() {
    this.editingFolder = null
    this.editingName = ''
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteFolder(folder: Folder) {
    this.contextMenu = null
    if (
      !confirm(
        $localize`Delete folder "${folder.name}"? Sub-folders will also be deleted. Documents will remain but lose their folder assignment.`
      )
    )
      return

    this.folderService
      .delete(folder)
      .pipe(first())
      .subscribe({
        next: () => {
          this.folderService.clearCache()
          // If we deleted the current folder, go up
          if (folder.id === this.currentFolderId) {
            this.router.navigate(['/folders'])
          } else {
            this.load()
          }
        },
        error: () =>
          this.toastService.showError($localize`Error deleting folder`),
      })
  }
}
