# PRODUCT REQUIREMENTS DOCUMENT (PRD)
## Personal Brain — Windows AI Second Brain & 3D Knowledge Universe

| Atribut | Nilai |
|---|---|
| Versi dokumen | 0.1.0 — Draft untuk review |
| Tanggal | 24 November 2026 |
| Status | **Draft — belum disetujui untuk implementasi** |
| Platform rilis pertama | Windows 10/11 (desktop) |
| Target pengguna awal | Satu pengguna lokal (single-user) |
| Model produk | Local-first, offline untuk pengelolaan catatan |
| Format sumber data | Markdown (`.md`) dan attachments dalam folder vault |
| Dokumen pendamping yang akan dibuat sesudah PRD | `SYSTEM_ARCHITECTURE.md`, `DATA_SCHEMA.md`, `MVP_TASKS.md`, `AGENTS.md` |

> **Catatan ruang lingkup:** Dokumen ini mendefinisikan *apa* yang harus dibangun, *untuk siapa*, dan *bagaimana menguji keberhasilannya*. Rincian implementasi, diagram komponen final, API, dan skema SQL akan diturunkan ke dokumen teknis setelah PRD disetujui. Ini bukan klaim bahwa produk sudah dibuat atau diuji.

---

## 1. Executive Summary

**Personal Brain** adalah aplikasi desktop Windows untuk menyimpan, menghubungkan, mencari, dan menggunakan kembali pengetahuan pribadi. Aplikasi menggabungkan pengelolaan vault Markdown yang kompatibel secara praktis dengan Obsidian, visualisasi pengetahuan sebagai *3D knowledge universe*, dan *shared AI memory* melalui protokol MCP untuk coding agents seperti Codex, Claude Code, dan Gemini CLI.

Pengguna menguasai file catatannya. File Markdown adalah sumber data utama untuk isi catatan; indeks pencarian dapat dibangun kembali. AI dapat membaca catatan yang diizinkan, menggunakan konteks untuk menjawab, dan **mengusulkan** penambahan atau perubahan memori. AI tidak boleh diam-diam mengubah pengetahuan yang telah disetujui pengguna.

**Prinsip utama:** aplikasi harus tetap berguna sebagai note manager walaupun internet, layanan AI, visualisasi 3D, atau MCP server sedang tidak tersedia.

### 1.1 Problem statement

1. Konteks proyek dan keputusan teknis tersebar di berbagai percakapan AI serta dokumen.
2. Saat berpindah dari satu AI agent ke agent lain, pengguna mengulang penjelasan yang sama.
3. Catatan berkembang tanpa sistem relasi dan pelacakan asal informasi yang jelas.
4. Sulit membedakan informasi yang diverifikasi pengguna dengan rangkuman atau dugaan AI.
5. Alat visual sering memperlihatkan graph yang menarik tetapi tidak membantu proses mencari, memahami, atau merawat pengetahuan.

### 1.2 Product vision

> Satu pusat pengetahuan yang dapat dikendalikan pengguna, dibaca lintas-AI, dinavigasi secara visual, dan tetap dapat digunakan tanpa bergantung pada satu vendor AI maupun satu aplikasi catatan.

### 1.3 Nilai utama

- **Portable:** catatan tetap dapat digunakan di luar Personal Brain.
- **Interoperable:** beberapa AI clients menggunakan sumber pengetahuan yang sama.
- **Traceable:** jawaban berbasis vault dapat ditelusuri ke catatan sumber.
- **Controllable:** perubahan memori dari AI melalui review pengguna.
- **Visual:** hubungan antarnote dapat dieksplorasi sebagai galaksi 3D.
- **Reliable:** tidak menukar keselamatan data dengan efek visual.

---

## 2. Pengguna dan Jobs-to-be-Done

### 2.1 Persona utama — Individual developer / AI power user

Pengguna Windows yang menangani beberapa proyek software dan menggunakan Codex, Claude Code, atau Gemini CLI. Membutuhkan riwayat keputusan, arsitektur, bug, penyelesaian, dan preferensi kerja yang dapat diakses kembali tanpa mengulang konteks dari awal.

**Job:** “Ketika saya berpindah agent atau kembali ke suatu proyek, saya ingin AI membaca konteks yang relevan dan terbaru agar pekerjaan berlanjut secara konsisten.”

### 2.2 Persona sekunder — Personal knowledge worker

Pengguna yang mengumpulkan catatan riset, ide, jurnal, serta referensi dan ingin menelusuri hubungan pengetahuan secara visual.

**Job:** “Ketika saya membuka catatan lama, saya ingin menemukan hubungannya dengan topik lain dan memahami bagaimana pengetahuan saya berkembang.”

### 2.3 Bukan target awal

- Organisasi multiuser dengan izin per tim.
- Pengguna yang membutuhkan kolaborasi cloud realtime.
- Pengguna mobile-first.
- Pengguna yang meminta AI melatih ulang model dasar dari catatan pribadi.

---

## 3. Goals, Non-goals, dan Prinsip Produk

### 3.1 Goals rilis 1.0

**G-01 — Vault yang benar-benar dapat dipakai.** Pengguna membuat/membuka vault, mengedit Markdown, mencari catatan, dan membuka catatan melalui tautan internal.

**G-02 — Kompatibilitas praktis dengan Obsidian.** Aplikasi dapat membaca vault yang sudah ada, termasuk Markdown dan wikilinks umum, tanpa mengubah data pengguna secara destruktif.

**G-03 — Knowledge universe yang berguna.** Graph 3D dapat mengantar pengguna dari visualisasi ke catatan yang sesungguhnya.

**G-04 — Memori bersama lintas-AI.** Minimal dua AI clients yang berbeda dapat menemukan dan membaca konteks vault yang sama melalui MCP.

**G-05 — AI memory yang bisa diaudit.** Perubahan memori yang diminta AI menjadi proposal terlebih dahulu, dengan alasan, sumber, status, dan riwayat keputusan.

**G-06 — Aman dan dapat dipulihkan.** Tersedia backup, pemulihan, penanganan konflik, serta pengujian akses di luar vault.

### 3.2 Non-goals untuk MVP

- Sinkronisasi cloud dan akun pengguna.
- Kolaborasi realtime/multiuser.
- Aplikasi Android/iOS/web.
- Mengkloning antarmuka, aset, kode, atau identitas Astrocortex.
- Mengimpor otomatis seluruh riwayat ChatGPT, Codex, Claude, atau Gemini tanpa akses dan izin yang sesuai.
- Melatih ulang bobot model AI dengan catatan vault.
- Mengaktifkan penulisan memori AI tanpa tinjauan secara default.
- Brain-shaped 3D visualization, animasi sinematik, dan fitur sosial.
- Plugin marketplace dan ekosistem ekstensi umum.

### 3.3 Prinsip keputusan produk

1. **Data safety > visual polish.**
2. **Markdown first > database lock-in.**
3. **Explicit permission > invisible automation.**
4. **Source-backed answer > confident hallucination.**
5. **Progressive complexity > massive first release.**
6. **Accessible conventional UI > compulsory 3D navigation.**

---

## 4. Ruang Lingkup Produk dan Prioritas

Prioritas mengikuti kategori:

- **P0:** wajib sebelum sebuah milestone dinyatakan lulus.
- **P1:** wajib untuk target rilis 1.0, tetapi bisa datang setelah fondasi P0.
- **P2:** peningkatan setelah alur utama stabil / dapat masuk setelah 1.0.

### 4.1 Matriks fitur

| ID | Kemampuan | Prioritas | Target |
|---|---|---|---|
| FR-001 | Create/open/select vault lokal | P0 | 0.1 |
| FR-002 | Browse folder, notes, attachments | P0 | 0.1 |
| FR-003 | Create/read/edit/rename/delete note dengan proteksi data | P0 | 0.1 |
| FR-004 | Markdown + frontmatter + wikilinks | P0 | 0.1 |
| FR-005 | Full-text search, filter, backlinks | P0 | 0.1 |
| FR-006 | File watcher dan deteksi konflik | P0 | 0.1 |
| FR-007 | Rebuildable search index | P0 | 0.1 |
| FR-008 | Editor Markdown dan navigasi desktop | P0 | 0.1 |
| FR-009 | Settings, onboarding, dan error states | P1 | 0.1 |
| FR-010 | Backup, restore, dan revision safety | P0 | Sebelum 0.3 |
| FR-011 | 3D graph berbasis catatan nyata | P0 | 0.2 |
| FR-012 | Fokus, filter, dan navigasi graph → note | P0 | 0.2 |
| FR-013 | Mode alternatif non-3D untuk navigasi | P1 | 0.2 |
| FR-014 | Read-only MCP retrieval tools | P0 | 0.3 |
| FR-015 | Integrasi minimal dua AI clients | P0 | 0.3 |
| FR-016 | Scope izin MCP dan kontrol akses agent | P0 | 0.3 |
| FR-017 | Memory proposal + approve/edit/reject | P0 | 0.3 |
| FR-018 | Provenance, audit event, dan revision log | P0 | 0.3 |
| FR-019 | AI Chat in-app berbasis sumber catatan | P1 | 1.0 |
| FR-020 | Hybrid / semantic retrieval | P2 | 1.0 opsional |
| FR-021 | Saran relasi dan duplikat | P2 | Setelah 0.3 |
| FR-022 | Windows installer dan tested restore | P0 | 1.0 |
| FR-023 | Export seluruh vault tanpa format proprietary | P0 | 1.0 |
| FR-024 | Pengaturan provider AI dan consent network | P1 | 1.0 |
| FR-025 | Perubahan vault dari aplikasi lain tetap sinkron | P0 | 0.1 |
| FR-026 | Update status catatan (verified, outdated, superseded) | P1 | 0.3 |

> **Definisi MVP:** MVP fungsional adalah rangkaian 0.1 → 0.2 → 0.3, diakhiri security/reliability gates. Rilis 1.0 menambahkan pemolesan, AI Chat bila matang, installer, dokumentasi, dan stabilisasi. Semantic search tidak boleh menghambat rilis jika keyword retrieval sudah memenuhi kebutuhan dan kualitas.

---

## 5. Detailed Functional Requirements

### 5.1 Vault Management (FR-001, FR-002, FR-003, FR-023)

**Aktor:** pengguna desktop.

**Perilaku wajib:**

1. Saat pertama membuka aplikasi, tampilkan pilihan **Create Vault** dan **Open Existing Vault**.
2. Dukung pemilihan direktori melalui dialog native Windows.
3. Aplikasi dapat membuka direktori vault yang hanya berisi Markdown biasa; jangan mewajibkan struktur folder khusus.
4. Dukung operasi create, open, save, rename, move, dan delete pada note; perubahan berisiko harus dapat dikonfirmasi atau dipulihkan.
5. Jika vault sudah berisi catatan, lakukan pemindaian non-destruktif. Jangan menulis ulang frontmatter pada semua file hanya untuk mengindeks.
6. Notes dan attachments tetap berada di filesystem pengguna. Metadata operasional yang tidak sesuai untuk Markdown dapat berada di app data.
7. Dukung ekspor/penyalinan vault tanpa format proprietary.
8. Saat akses file ditolak, file hilang, disk penuh, atau vault berpindah, tampilkan error yang dapat ditindaklanjuti.

**Acceptance criteria:**

- **AC-001:** Pengguna dapat membuat dan membuka vault di path Windows yang dipilih.
- **AC-002:** Membuka vault berisi 100 note fixture tidak mengubah konten/metadata file tanpa tindakan edit pengguna.
- **AC-003:** Save lalu restart menghasilkan isi note sama persis pada pengujian normal.
- **AC-004:** Rename dan move memperbarui navigasi; konsekuensi terhadap links ditunjukkan dan ditangani sesuai aturan yang didokumentasikan.
- **AC-005:** Operasi gagal tidak membuat file Markdown menjadi file parsial yang tidak dapat dibuka.

### 5.2 Markdown, Links, dan Interoperabilitas (FR-004, FR-025)

**Perilaku wajib:**

- Parse CommonMark-style Markdown, YAML frontmatter, wikilinks (`[[Note]]`), Markdown links (`[Label](relative/path.md)`), headings, tags, dan attachments umum.
- Tampilkan links yang dapat diselesaikan serta broken links secara berbeda.
- Perhatikan nama note duplikat di folder berbeda; resolusi link harus deterministik atau meminta pemilihan.
- Catatan existing yang belum memiliki stable ID tetap dapat dibuka. Strategi penetapan ID harus meminimalkan perubahan massal dan dijelaskan pada dokumen data schema.
- Pertahankan bagian frontmatter/Markdown yang tidak dikenali pada operasi read/write biasa.
- Tidak mengedit folder `.obsidian/` kecuali pengguna secara eksplisit mengotorisasi fitur yang membutuhkannya.

**Acceptance criteria:**

- **AC-006:** Fixture berisi Markdown links, wikilinks, YAML frontmatter, dan attachments dapat dibuka tanpa kehilangan isi.
- **AC-007:** Link valid membawa pengguna ke target yang benar; broken link terlihat jelas.
- **AC-008:** File yang diubah melalui Obsidian atau editor eksternal akan terlihat setelah sinkronisasi/reindex.
- **AC-009:** Mengedit satu catatan tidak menyebabkan perubahan tak terkait pada catatan lain.

### 5.3 Editor, Navigasi, dan Search (FR-005, FR-008, FR-009)

**Perilaku wajib:**

- Sidebar berisi folders/tags dan global search.
- Editor Markdown mendukung syntax highlighting, preview, undo/redo, save status, dan keyboard navigation.
- Recent notes, pinned notes, backlinks, dan related notes tersedia tanpa perlu membuka 3D.
- Search mencakup title dan body serta mendukung filter dasar folder/tag.
- Hasil search menampilkan judul, snippet, dan lokasi note.
- Berikan empty/loading/error state yang informatif.

**Acceptance criteria:**

- **AC-010:** Pengguna membuat, mengubah, mencari, dan membuka note tanpa graph atau koneksi internet.
- **AC-011:** Search menghasilkan note yang diketahui mengandung keyword uji; filter folder berfungsi.
- **AC-012:** Undo/redo dan indikator unsaved changes berfungsi pada pengujian editor.
- **AC-013:** Navigasi utama dapat dipakai dengan keyboard untuk fungsi inti.

### 5.4 Indexing, Watcher, dan Recovery (FR-006, FR-007, FR-010)

**Perilaku wajib:**

- SQLite/search index merupakan turunan dari vault untuk data catatan; indeks bisa dihapus dan dibuat ulang tanpa menghapus vault.
- Monitor create/modify/rename/delete eksternal dan lakukan incremental reindex.
- Jika file berubah di disk sejak dibuka, cegah silent overwrite: bandingkan versi/hash dan minta pengguna membandingkan, reload, atau menyimpan alternatif.
- Gunakan penulisan file yang aman dan pemulihan setelah kegagalan.
- Backup berisi vault dan data aplikasi non-derivatif yang diperlukan untuk mengembalikan proposal, pengaturan izin, serta audit/revisi; jangan menganggap rebuild index memulihkan informasi operasional yang hilang.
- Restore dilakukan ke lokasi yang dipilih, dengan preview dampak dan proteksi agar tidak menimpa data tanpa persetujuan.

**Acceptance criteria:**

- **AC-014:** Setelah SQLite index dihapus, rebuild mengembalikan hasil search dan graph sesuai sumber Markdown.
- **AC-015:** Perubahan catatan dari editor eksternal tercermin tanpa restart penuh pada kondisi pengujian normal.
- **AC-016:** Dua penulis pada note yang sama tidak mengakibatkan lost update secara diam-diam.
- **AC-017:** Backup dan restore yang diuji mengembalikan note serta data non-derivatif yang dijanjikan.

### 5.5 3D Knowledge Universe (FR-011, FR-012, FR-013)

**Perilaku wajib:**

- Tampilkan **note = node/bintang** dan **relasi/link = edge**; cluster berdasarkan folder/project/tag mengikuti mode yang dipilih.
- Gunakan relasi eksplisit yang ada di catatan; relasi yang hanya disarankan AI harus memiliki indikator terpisah dan tidak diklaim sebagai fakta.
- Dukung orbit, pan, zoom, fit graph, reset camera, filter, highlight, select node, dan **Open Note**.
- Pencarian dari graph harus membawa pengguna ke node hasil pencarian.
- Performance controls: mengurangi label, animasi, dan efek ketika jumlah node tinggi; sediakan reduced motion atau fallback 2D/list.
- Layout dapat bervariasi tanpa mengubah identitas catatan atau relasi yang tersimpan.

**Acceptance criteria:**

- **AC-018:** Vault fixture dengan link menghasilkan graph sesuai data sumber, bukan hardcoded demo graph.
- **AC-019:** Klik node membuka note yang tepat; perubahan link dalam note memperbarui graph setelah index sync.
- **AC-020:** Filter proyek/tag dan reset camera bekerja.
- **AC-021:** Pada target hardware yang didokumentasikan, skenario 1.000 node/2.500 edge memenuhi tolok ukur responsivitas yang disepakati dan diukur; fallback tersedia bila perangkat tidak mampu.

### 5.6 Read-only Shared AI Memory via MCP (FR-014, FR-015, FR-016)

**Perilaku wajib:**

- Sediakan MCP server lokal yang dapat dijalankan terpisah dari desktop app dan memakai knowledge core yang sama.
- Minimal tools: `search_memory`, `read_note`, `get_project_context`, `get_related_notes`, `list_vaults` (daftar yang *authorized* saja).
- Semua tools memiliki schema input yang tervalidasi, batas ukuran hasil, error yang jelas, dan sumber/citation metadata.
- Default agent access adalah *no access until configured*; pengguna memilih vault yang boleh dibaca.
- Batasi akses pada lokasi yang diizinkan; validasi canonical path, symlink/junction, traversal, dan pemisahan drive Windows.
- Tidak menganggap teks dalam catatan sebagai perintah trusted yang boleh mengubah aturan agent.
- Audit event cukup informatif tanpa menyimpan konten sensitif lebih banyak dari yang diperlukan.

**Acceptance criteria:**

- **AC-022:** Codex dan satu agent berbeda berhasil memanggil tool pencarian yang sama atas vault uji.
- **AC-023:** Permintaan membaca file di luar vault yang diizinkan ditolak pada tes traversal, symlink, dan path Windows.
- **AC-024:** Menonaktifkan izin agent mencegah akses pada permintaan berikutnya.
- **AC-025:** Tool mengembalikan note ID/path relatif dan excerpt/sumber yang dapat diverifikasi.

### 5.7 Memory Proposal & Governance (FR-017, FR-018, FR-026)

**Perilaku wajib:**

- AI dapat membuat **proposal**, bukan langsung menetapkan fakta.
- Proposal berisi: jenis perubahan, target note, teks perubahan atau patch, alasan, sumber, agent, waktu, dan status.
- Status proses minimal `proposed → approved/rejected`; `superseded` dapat dipakai untuk pengetahuan yang digantikan, bukan otomatis sinonim rejected.
- Status verifikasi fakta (`unverified`, `user_verified`, `outdated`) dibedakan dari status workflow proposal.
- Review UI memungkinkan **Approve**, **Edit & Approve**, **Reject**, dan melihat diff.
- Saat approval, deteksi jika target berubah sejak proposal dibuat. Jika berubah, minta review/merge baru.
- Simpan revision dan audit event; pengguna dapat melihat siapa/agent apa yang mengusulkan perubahan.
- Sediakan cara pengguna menghapus, mengoreksi, atau mengganti pengetahuan dan menghilangkan indeks/embedding turunan sesuai kebijakan retensi.

**Acceptance criteria:**

- **AC-026:** Proposal tidak mengubah catatan utama sebelum approval pengguna.
- **AC-027:** Approved proposal menghasilkan perubahan yang dapat ditelusuri dan, bila sesuai, dibatalkan dengan restore revision.
- **AC-028:** Reject tidak mengubah catatan target.
- **AC-029:** Proposal berdasarkan versi lama tidak dapat diam-diam menimpa perubahan terbaru.
- **AC-030:** Sumber dan agent pengusul terlihat di Memory Center.

### 5.8 In-app AI Chat & Retrieval Enhancement (FR-019, FR-020, FR-021, FR-024)

**Perilaku wajib:**

- Chat mengakses catatan hanya dalam vault dan scope yang dipilih.
- Respons *grounded* menampilkan sumber note yang dipakai; ketika sumber tidak cukup, AI menyatakan keterbatasan secara jelas.
- Pengguna secara sadar menghubungkan provider dan mengizinkan transfer data jika provider eksternal digunakan.
- Credentials tidak disimpan di note, repository, log, atau plaintext configuration.
- Keyword retrieval menjadi baseline; semantic/hybrid search ditambahkan jika benar-benar meningkatkan hasil pada evaluasi.
- Relasi atau duplikat yang disarankan AI ditandai sebagai saran hingga diterima.

**Acceptance criteria:**

- **AC-031:** Pertanyaan yang jawabannya ada pada vault fixture menghasilkan jawaban yang merujuk ke note relevan pada evaluasi manual terkontrol.
- **AC-032:** Tanpa API key/koneksi, editor, search lokal, dan graph tetap berfungsi.
- **AC-033:** Pengguna diberi kejelasan ketika teks catatan akan dikirim ke layanan AI eksternal.
- **AC-034:** Embedding/index turunan dapat di-rebuild dan dihapus ketika konfigurasi berubah.

### 5.9 Packaging, Export, dan Lifecycle (FR-022, FR-023)

**Perilaku wajib:**

- Hasilkan Windows installer dengan prosedur instalasi/uninstal yang jelas.
- Installer/uninstaller tidak menghapus vault pengguna secara default.
- Sediakan dokumentasi lokasi data, cara backup, restore, dan cara menghubungkan client MCP.
- Pastikan vault existing tetap bisa dibuka dengan editor Markdown lain setelah aplikasi dihapus.

**Acceptance criteria:**

- **AC-035:** Aplikasi hasil installer berjalan pada clean Windows test environment tanpa development toolchain.
- **AC-036:** Uninstall tidak menghapus vault yang berada di folder pengguna.
- **AC-037:** Panduan restore diuji end-to-end pada backup sampel.

---

## 6. User Journeys & Core Flows

### Journey A — Pengguna baru membuat vault

1. Buka Personal Brain → pilih **Create Vault**.
2. Pilih folder lokal → aplikasi memvalidasi izin dan isi folder.
3. Aplikasi membuat vault tanpa menimpa file existing.
4. Pengguna membuat note → simpan → note muncul pada daftar dan search.
5. Setelah note ditautkan, graph menampilkan edge yang benar.

**Success condition:** pengguna bisa mulai mencatat tanpa akun, internet, atau API key.

### Journey B — Pengguna membuka vault Obsidian lama

1. Pilih **Open Existing Vault**.
2. Preview hasil pemindaian: jumlah note, attachment, warning link, dan file bermasalah.
3. Konfirmasi pembukaan non-destruktif.
4. Indeks dibuat di app data → note, tags, links muncul.
5. Edit satu note di Obsidian → Personal Brain mendeteksi perubahan.

**Success condition:** impor/open tidak merusak file existing dan perubahan lintas-editor tetap aman.

### Journey C — Berpindah AI agent di tengah proyek

1. Pengguna mengizinkan Codex membaca vault proyek.
2. Codex memanggil `get_project_context` / `search_memory` dan menggunakan sumber yang relevan.
3. Codex mengajukan proposal keputusan baru.
4. Pengguna me-review dan approve.
5. Claude Code atau Gemini CLI membaca keputusan yang sama pada sesi berikutnya.

**Success condition:** keputusan terbaca lintas dua agent tanpa pengguna menempel ulang seluruh percakapan.

### Journey D — Menemukan pengetahuan lewat galaksi

1. Buka Universe → cari cluster proyek.
2. Pilih satu bintang/note.
3. Lihat ringkasan dan catatan terhubung → Open Note.
4. Edit/menambahkan link → graph diperbarui.

**Success condition:** graph mempercepat navigasi, bukan hanya dekorasi.

### Journey E — AI memberikan informasi keliru

1. AI mengusulkan perubahan berdasarkan asumsi yang salah.
2. Memory Center menampilkan sumber, alasan, dan diff.
3. Pengguna reject atau edit proposal.
4. Catatan utama tetap aman jika proposal ditolak.

**Success condition:** kesalahan AI tidak otomatis menjadi memori terverifikasi.

### Journey F — Konflik editor eksternal

1. Catatan dibuka di Personal Brain.
2. Obsidian menyimpan versi baru pada catatan yang sama.
3. Personal Brain mendeteksi perubahan versi ketika pengguna mencoba save.
4. Tampilkan diff atau pilihan reload/save as/merge terkontrol; jangan silent overwrite.

**Success condition:** perubahan pengguna tidak hilang tanpa pemberitahuan.

---

## 7. UX & Information Architecture

### 7.1 Navigasi utama

| Area | Isi | Fungsi utama |
|---|---|---|
| **Home / Dashboard** | Recent notes, pinned notes, proyek aktif, pending proposals | Mulai bekerja cepat |
| **Knowledge** | Folder tree, editor, backlinks, search | Mengelola catatan |
| **Universe** | 3D knowledge graph, cluster, filter, detail panel | Mengeksplorasi relasi |
| **AI Brain** | Chat, source panel, context scope | Bertanya dengan konteks vault |
| **Memory Center** | Proposal queue, diff, revisions, audit | Mengontrol memori AI |
| **Settings** | Vaults, tema, backup, AI providers, MCP permissions | Konfigurasi dan keamanan |

### 7.2 Prinsip UX

- Fokus pada keterbacaan; efek visual tidak mengurangi kontras atau performa editor.
- Navigasi penting tersedia tanpa 3D.
- Desain mendukung mouse dan keyboard.
- Ada label jelas untuk **verified**, **suggested**, **outdated**.
- Sebelum aksi berisiko, tampilkan konsekuensi dan opsi pemulihan.
- Tidak ada false success state: operasi baru dianggap selesai setelah write/commit terkonfirmasi.
- Gunakan desain desktop responsif terhadap ukuran window dan DPI scaling Windows.
- Sediakan reduced motion untuk animasi yang dapat mengganggu.

### 7.3 Empty/error states

- Belum ada vault: tampilkan Create/Open.
- Vault kosong: ajak buat note pertama.
- Graph tanpa link: tetap tampilkan node, berikan saran cara menautkan.
- MCP belum dikonfigurasi: jelaskan fungsi, izin, dan langkah pengaturan.
- Provider AI tidak tersedia: tampilkan pesan tanpa memblokir kerja offline.
- Conflict file: tampilkan keputusan yang aman tanpa otomatis membuang perubahan.

---

## 8. Non-functional Requirements (NFR)

| ID | Kategori | Kebutuhan dan ukuran penerimaan |
|---|---|---|
| NFR-001 | Offline | Create/read/edit/search/index/graph berjalan tanpa internet; tes dengan network disabled |
| NFR-002 | Data integrity | Pada skenario normal, crash injection, disk failure simulasi, dan concurrent edit, tidak ada silent data loss; semua kegagalan dilaporkan |
| NFR-003 | Index recoverability | Hilangnya indeks SQLite tidak menghilangkan isi note; rebuild pada fixture harus mengembalikan hasil yang sama |
| NFR-004 | Search performance | Sasaran awal P95 pencarian keyword <300 ms pada 1.000 note fixture setelah warm-up, di baseline hardware yang dicatat |
| NFR-005 | Graph performance | 1.000 nodes / 2.500 edges dapat dinavigasi tanpa freeze berkepanjangan pada baseline hardware; metrik frame time dan input latency dicatat |
| NFR-006 | Portability | Markdown tetap dapat dibuka oleh Obsidian/VS Code; golden fixture tests tidak menunjukkan modifikasi tak diinginkan |
| NFR-007 | Privacy | Tidak ada pengiriman isi vault ke layanan eksternal sebelum pengguna mengaktifkan penyedia dan scope-nya |
| NFR-008 | Least privilege | MCP dibatasi per vault, default deny, path traversal/symlink escape tests wajib lolos |
| NFR-009 | Security | Tidak ada eksekusi instruksi/skrip dari note sebagai perintah aplikasi atau agent tanpa otorisasi |
| NFR-010 | Maintainability | Modular Rust core, bounded interfaces, typed API, automated tests, formatter, lint, docs |
| NFR-011 | Accessibility | Fungsi inti dapat dijalankan tanpa graph 3D; keyboard support dan reduced motion |
| NFR-012 | Installability | Installer dites pada clean Windows setup; uninstall tidak menghapus vault |
| NFR-013 | Backup & restore | Backup dan restore penuh untuk data yang dijanjikan harus lulus tes skenario sampel |
| NFR-014 | Observability | Error yang dapat ditindaklanjuti; logs redacted, tidak menyimpan rahasia atau dump catatan penuh secara default |
| NFR-015 | Dependency hygiene | Versi dependency dikunci, vulnerability scan/review rutin, dan license review sebelum distribusi |

**Batas metrik:** spesifikasi perangkat baseline (CPU, RAM, GPU, penyimpanan, versi Windows, ukuran fixture) harus ditetapkan saat fase foundation. Sasaran performa di atas adalah *engineering targets*, bukan hasil pengujian yang telah dicapai.

---

## 9. Data Ownership, Privacy, dan Security Requirements

### 9.1 Data ownership

- Pengguna tetap memiliki file Markdown dan attachments.
- Catatan tidak dipindahkan ke cloud tanpa permintaan eksplisit.
- Seluruh indeks turunan dapat dibangun ulang dari data sumber jika informasi tersebut memang derivatif.
- Data non-derivatif seperti proposal dan persetujuan harus ikut kebijakan backup/restore, tidak hanya berada di indeks ephemeral.

### 9.2 Threat model minimum

| Risiko | Kontrol produk |
|---|---|
| Agent membaca file di luar vault | Authorized vault scope + canonical path validation + tes traversal/junction/symlink |
| Prompt injection dalam note | Teks note diperlakukan sebagai data tidak tepercaya; instruksi agent terpisah |
| AI menulis fakta salah | Proposal approval gate, source attribution, status verifikasi |
| Konflik Obsidian vs aplikasi | Version/hash comparison + conflict UI |
| Data hilang karena crash | Atomic write + tested backups + recovery |
| Kebocoran API key | OS credential store dan log redaction |
| Remote AI menerima catatan sensitif | Explicit provider setup, scope selection, disclosure transfer |
| Catatan mengandung link/konten berbahaya | Safe Markdown rendering, URL sanitization, tidak execute script |
| Index database korup | Rebuild index dari Markdown dan restore data non-derivatif |

### 9.3 Kebijakan penggunaan AI

1. Tool baca diizinkan hanya pada vault yang dipilih pengguna.
2. Tool proposal menulis ke queue, bukan langsung ke isi note.
3. Setiap persetujuan perubahan memiliki pencatat waktu dan diff.
4. *AI-generated assertion* tidak disamakan dengan fakta terverifikasi.
5. Jika provider cloud dipakai, UI menjelaskan bahwa potongan catatan dapat dikirim ke provider tersebut.
6. Fitur otomatisasi yang lebih berisiko adalah opt-in di masa depan, bukan default MVP.

### 9.4 Penghapusan dan retensi

- Pengguna dapat menghapus atau memperbarui note dan proposal.
- Penghapusan memori harus memperhitungkan cache, search index, embedding, revisions, dan backup.
- Karena backup/version history dapat menahan salinan, UI harus menjelaskan cakupan penghapusan dan kebijakan retensinya.
- Jangan mengklaim “terhapus selamanya” jika data mungkin masih berada di backup yang belum kedaluwarsa.

---

## 10. Technical Constraints & Dependencies (Baseline, belum final)

| Lapisan | Pilihan awal | Rationale |
|---|---|---|
| Desktop shell | Tauri 2 | Native Windows, akses filesystem terkontrol |
| Frontend | React + TypeScript | Komponen UI dan state yang terstruktur |
| Native core | Rust shared crate | Logic vault tunggal untuk desktop dan MCP |
| Notes storage | Markdown di filesystem | Portability dan Obsidian interoperability |
| Index/search | SQLite + FTS5 | Offline full-text search, indeks reconstructible |
| Graph engine | Three.js / 3d-force-graph | Visualisasi knowledge graph interaktif |
| AI interoperability | MCP stdio server | Shared context bagi external AI clients |
| Version safety | Revision history + tested backup | Recoverability dan audit |
| AI Chat | Provider adapter opsional | Hindari ketergantungan satu provider |
| Semantic search | Ditentukan setelah evaluasi | Jangan menambah kompleksitas sebelum dibutuhkan |

**Keputusan implementasi terbuka:** strategi assignment stable IDs untuk vault lama; conflict resolution UX; lokasi penyimpanan non-derivatif; library Markdown parser/editor; apakah mendukung beberapa vault sekaligus pada 1.0; standar paket installer dan update mechanism.

---

## 11. Milestones, Roadmap, dan Release Gates

Rencana mengikuti **8 fase / 30 langkah**. Tanggal bersifat estimasi perencanaan, bukan komitmen pengiriman.

| Fase | Langkah | Deliverable | Exit gate |
|---|---|---|---|
| **1. Planning** | 1–5 | PRD, Architecture, Data Schema, MVP Tasks, AGENTS | Dokumen konsisten, scope dan AC disetujui |
| **2. Foundation** | 6–9 | Windows toolchain, Tauri app, workspace, CI/test | Clean build dan baseline smoke test |
| **3. Vault Engine** | 10–14 | Vault CRUD, Markdown parser, index, watcher, search | AC-001–009, AC-014–017 lulus |
| **4. Desktop UI** | 15–18 | App shell, Markdown editor, dashboard, settings | AC-010–013 lulus pada Windows |
| **5. 3D Universe** | 19–21 | Graph, navigation, performance control | AC-018–021 dan fallback lulus |
| **6. AI Shared Memory** | 22–25 | MCP, client integration, proposals, review UI | AC-022–030 lulus dengan dua agent berbeda |
| **7. Intelligence** | 26–28 | In-app AI Chat, enhanced retrieval, memory quality | AC-031–034 sesuai fitur yang diaktifkan |
| **8. Release** | 29–30 | Security/regression audit, installer, recovery docs | AC-035–037, critical tests dan security gate lulus |

### 11.1 MVP versions

- **0.1 — Usable Knowledge Vault:** vault, editor, search, links, watcher, baseline backup.
- **0.2 — Visual Knowledge Universe:** graph 3D yang berbasis data nyata, navigasi, fallback.
- **0.3 — Shared AI Memory:** MCP read/search, minimal dua clients, proposals, approval/audit.
- **1.0 — Windows Stable Release:** QA, security hardening, installer, documentation, optional AI Chat bila stabil.

### 11.2 Hard release blockers

Rilis tidak boleh diberi status siap pakai bila salah satu kondisi berikut terjadi:

1. File Markdown dapat tertimpa secara diam-diam akibat konflik edit yang diketahui.
2. MCP dapat membaca file di luar scope yang diizinkan.
3. AI proposal dapat mengubah note tanpa approval pengguna.
4. Backup/restore yang dijanjikan gagal diuji.
5. Installer menyebabkan kehilangan data existing atau tidak bisa dijalankan di test environment bersih.
6. Graph hanya menggunakan data demo dan tidak mencerminkan vault nyata.
7. Hasil test dinyatakan lulus tanpa bukti eksekusi.

---

## 12. Verification & QA Strategy

### 12.1 Test layers

- **Unit tests:** parsing, note link resolution, path validation, proposal state machine, diff, query ranking.
- **Integration tests:** vault CRUD ↔ index, watcher ↔ disk edits, desktop ↔ Rust core, MCP ↔ permission layer.
- **End-to-end Windows:** onboarding, create/open/edit/search, 3D navigation, approval workflow, backup restore.
- **Security tests:** traversal, symlink/junction escape, prompt-injection payloads, unauthorized tool access, malicious Markdown/link handling.
- **Reliability tests:** crash during write, concurrent saves, disk full/read-only, corrupted SQLite, interrupted rebuild.
- **Performance tests:** indexed 1.000-note fixture dan graph 1.000 nodes / 2.500 edges pada baseline device.
- **Compatibility tests:** vault fixtures dari Obsidian, VS Code, paths dengan Unicode/spaces, berbagai line endings, nested folders.

### 12.2 Test fixtures

Buat fixture non-pribadi yang merepresentasikan:

- Vault kosong.
- Vault 100 catatan dengan Markdown/frontmatter/tags.
- Vault 1.000 catatan dengan edge 2.500 dan beberapa broken links.
- Nama file/paths berbeda tetapi judul sama.
- Catatan tanpa frontmatter dan catatan dengan properti tak dikenali.
- File corrupted, invalid YAML, Unicode dan long path.
- External editor conflict dan simultaneous agent proposal.

### 12.3 QA evidence

Untuk setiap milestone simpan:

1. Daftar acceptance criteria yang diuji.
2. Perintah test/build dan hasil aktual.
3. Perangkat/OS yang digunakan.
4. Bug kritis dan regresi terbuka.
5. Screenshot atau recording bila menyangkut UI.
6. Known limitations sebelum sign-off.

---

## 13. Success Metrics & Evaluation

### 13.1 Kinerja produk

| Metrik | Target awal | Cara mengukur |
|---|---|---|
| Vault create/open | 100% pada fixture utama | E2E pass rate |
| Interoperabilitas Markdown | Tidak ada perubahan tidak diminta pada fixture | Hash/diff golden fixtures |
| Search keyword P95 | <300 ms pada 1.000 notes, warmed index | Repeated benchmark terukur |
| Graph navigation | Tidak freeze berkepanjangan pada 1.000/2.500 | Profiling pada baseline hardware |
| MCP interoperability | 2 AI client berbeda berhasil | End-to-end scripted test |
| Unauthorized MCP reads | 0 kasus berhasil di negative security tests | Path and permission suite |
| Unauthorized memory commits | 0 kasus berhasil di workflow tests | Proposal approval tests |
| Backup/restore | 100% test scenario utama berhasil | Restore & data verification |

### 13.2 Kualitas retrieval

Evaluasi dengan set pertanyaan uji yang jawabannya diketahui dari vault fixture:

- Apakah tool mengambil note relevan?
- Apakah hasil menyertakan sumber?
- Apakah konten usang ditandai jika terdapat note yang menggantikannya?
- Apakah sistem menyatakan ketidaktahuan ketika tidak ada informasi?

Buat baseline sebelum menambah embeddings. Semantic search hanya dinyatakan meningkatkan kualitas setelah ada perbandingan yang terukur.

### 13.3 Product usability

Lakukan uji tugas sederhana dengan pengguna target: membuat note, menemukan note lama, membuka node di graph, menyetujui proposal, serta memulihkan note. Catat keberhasilan tugas, langkah yang membingungkan, dan kebutuhan bantuan. Jangan menganggap visual bagus sebagai bukti UX bagus.

---

## 14. Dependencies, Risks, dan Mitigations

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Scope creep ke visual/animasi | MVP tertunda | Release gate per fase; efek sinematik P2 |
| Kompatibilitas Obsidian kurang matang | Kepercayaan pengguna turun | Golden fixtures dan non-destructive opening |
| File write conflict | Data hilang | Version checks, safe writes, restore tests |
| MCP permission boundary lemah | Kebocoran data lokal | Default deny, authorized scope, security suite |
| AI hallucination menjadi memori | Keputusan salah berulang | Approval, provenance, status verifikasi |
| Index tidak selaras dengan filesystem | Search/graph salah | File watcher + reconciliation + rebuild |
| Graph berat di GPU tertentu | UI tidak responsif | Profiling, budget render, fallback list/2D |
| Rust/Tauri build berbeda pada Windows | Instalasi gagal | CI dan clean Windows installer tests |
| Biaya/privasi AI cloud | Penggunaan tidak transparan | Optional provider, explicit consent, offline fallback |
| Banyak agent bekerja pada file sama | Perubahan kode saling menimpa | Modul owner, task gating, branch isolation |
| Ketergantungan framework cepat berubah | Maintenance tinggi | Dependency review dan lockfile |

---

## 15. Open Questions & Decisions Needed Before Engineering

Keputusan berikut harus dijawab dalam dokumen arsitektur atau rapat review PRD, bukan ditebak diam-diam oleh coding agent.

| ID | Pertanyaan | Rekomendasi awal |
|---|---|---|
| D-01 | Vault dapat lebih dari satu pada MVP? | Satu vault aktif pada sesi pertama, struktur siap multi-vault |
| D-02 | Cara memberi stable ID pada note Obsidian lama? | Mapping non-destruktif lebih dahulu; jangan mass rewrite |
| D-03 | Bagaimana link saat file dipindah/rename? | Preview perubahan dan opsi update link terkontrol |
| D-04 | Lokasi metadata non-derivatif (proposal/revision)? | App-data terpisah, masuk cakupan backup/restore |
| D-05 | Kebijakan penghapusan backup dan revisi? | Retensi dapat diatur, jelaskan dampak delete |
| D-06 | Default AI client permissions? | Deny sampai pengguna grant; read-only terlebih dahulu |
| D-07 | Apakah AI Chat wajib untuk 1.0? | P1, boleh ditunda jika memblokir stabilisasi |
| D-08 | Embedded semantic search provider? | Tidak diputuskan sebelum keyword baseline |
| D-09 | Minimum spesifikasi hardware? | Tetapkan setelah benchmark build awal |
| D-10 | Auto-update aplikasi? | Ditunda setelah installer manual stabil |
| D-11 | Kapan approval dapat di-batch? | Hanya setelah review UX dan risiko tersedia |
| D-12 | Apakah startup MCP membutuhkan desktop berjalan? | Tidak; executable terpisah memakai shared core |

---

## 16. Definition of Done (DoD)

Satu fitur berstatus **Done** hanya jika:

- Kebutuhan dan acceptance criteria terpenuhi.
- Perubahan memiliki test yang relevan dan test dijalankan.
- Tidak menambahkan akses file atau jaringan di luar izin yang ditetapkan.
- Tidak merusak interoperabilitas vault.
- Error dan empty state yang relevan ditangani.
- Jika ada perubahan data, migrasi/backup/rollback didokumentasikan.
- Laporan implementasi menyebut file terdampak, hasil test, dan keterbatasan.
- Review dilakukan untuk perubahan yang menyentuh keamanan dan data integrity.

**PRD sign-off gate:** ruang lingkup, prioritas, asumsi, open questions kritis, metrik target, dan acceptance criteria disetujui sebelum tugas coding utama dijalankan.

---

## 17. Next Documents (urutan penyusunan)

1. **`SYSTEM_ARCHITECTURE.md`** — diagram komponen, dependency graph, proses desktop/MCP, interfaces, exception model, security boundaries, locking/coordination strategy.
2. **`DATA_SCHEMA.md`** — Markdown frontmatter, stable IDs, SQLite tables, constraints, migrations, event/revision/proposal lifecycle.
3. **`MVP_TASKS.md`** — pecah FR/AC menjadi 30 langkah dan subtasks, dependensi, effort, acceptance evidence, per-agent ownership.
4. **`AGENTS.md`** — aturan membaca spesifikasi, izin perubahan, pembagian kerja, verifikasi, pelaporan, dan larangan destructive operations.

**Aturan:** perubahan desain teknis yang menyimpang dari PRD harus dicatat sebagai keputusan eksplisit dan menyesuaikan acceptance criteria yang relevan; jangan diam-diam memperlebar scope.

---

## 18. Approval Record

| Peran | Status | Catatan |
|---|---|---|
| Product owner | Menunggu review | Ruang lingkup dan prioritas |
| Software architect | Menunggu review | Feasibility dan risiko |
| Security/data reviewer | Menunggu review | Vault safety dan AI permissions |
| QA reviewer | Menunggu review | Testability dan quality gates |

**Status dokumen:** Draft v0.1.0. Belum merupakan persetujuan untuk implementasi kode.
