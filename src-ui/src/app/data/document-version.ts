import { ObjectWithId } from './object-with-id'

export interface DocumentVersion extends ObjectWithId {
  version_number: number
  archived_at: string
  title: string
  original_filename?: string
  mime_type?: string
  page_count?: number
  document_created?: string
  checksum: string
  has_archive: boolean
}
