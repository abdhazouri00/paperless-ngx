import { HttpClient } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import { environment } from 'src/environments/environment'
import { DocumentVersion } from 'src/app/data/document-version'

@Injectable({
  providedIn: 'root',
})
export class DocumentVersionService {
  private http = inject(HttpClient)

  private baseUrl(documentId: number, suffix = ''): string {
    return `${environment.apiBaseUrl}documents/${documentId}/versions/${suffix}`
  }

  list(documentId: number): Observable<DocumentVersion[]> {
    return this.http.get<DocumentVersion[]>(this.baseUrl(documentId))
  }

  download(documentId: number, versionId: number): void {
    window.open(this.baseUrl(documentId, `${versionId}/download/`), '_blank')
  }

  restore(documentId: number, versionId: number): Observable<any> {
    return this.http.post(this.baseUrl(documentId, `${versionId}/restore/`), {})
  }
}
