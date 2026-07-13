(function () {
    const STATE = {
        files: [],
        selectedFileId: null,
        isConverting: false,
        cancelFlag: false,
        ffmpeg: null,
        notifPermission: false,
        settings: {
            format: 'mp3',
            preset: 'Music',
            bitrate: '192',
            customBitrate: '',
            vbr: false,
            sampleRate: '44100',
            channels: '2',
            normalize: false,
            trimStart: '',
            trimEnd: '',
            filenameTemplate: '{name}.{format}',
            mergeToOne: false
        }
    };

    const PURE = {
        sanitizeFilename: (name, existingSet) => {
            let base = name.replace(/\.[^/.]+$/, '');
            base = base.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'output';
            if (base.length > 120) base = base.substring(0, 120);
            let finalName = base + '.mp3';
            if (existingSet && typeof existingSet.has === 'function') {
                let i = 1;
                while (existingSet.has(finalName)) {
                    finalName = `${base} (${i}).mp3`;
                    i++;
                }
                if (typeof existingSet.add === 'function') existingSet.add(finalName);
            }
            return finalName;
        },
        estimateMiB: (sec, kbps) => {
            const s = parseFloat(sec), k = parseFloat(kbps);
            return isNaN(s) || isNaN(k) || s <= 0 || k <= 0 ? 0 : (s * k) / 8192;
        },
        clampProgress: p => isNaN(p) || p < 0 ? 0 : (p > 1 ? 1 : p),
        pickExtension: name => { const parts = name.split('.'); return parts.length > 1 ? parts.pop().toLowerCase() : ''; },
        formatBytes: mib => {
            const m = parseFloat(mib);
            if (isNaN(m) || m <= 0) return '0.0 KiB';
            if (m < 1) return (m * 1024).toFixed(1) + ' KiB';
            if (m < 1024) return m.toFixed(1) + ' MiB';
            return (m / 1024).toFixed(2) + ' GiB';
        },
        isAudioOnly: file => {
            const t = file.type || '';
            const ext = file.name.split('.').pop().toLowerCase();
            return t.startsWith('audio/') || ['mp3','wav','flac','ogg','opus','m4a','aac','wma'].includes(ext);
        }
    };

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function initApp() {
        bindEvents();
        loadSettings();
        checkSharedArrayBuffer();
    }

    function checkSharedArrayBuffer() {
        if (typeof SharedArrayBuffer === 'undefined') {
            logMsg('Warning: SharedArrayBuffer not available. Single-threaded mode will be slower.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  BIND EVENTS
    // ─────────────────────────────────────────────────────────────
    function bindEvents() {
        const $ = id => document.getElementById(id);

        // ── Browse buttons ──────────────────────────────────────
        $('vcs-select-files-btn').addEventListener('click', e => {
            e.stopPropagation();
            $('vcs-file-input').click();
        });
        $('vcs-select-folder-btn').addEventListener('click', e => {
            e.stopPropagation();
            $('vcs-folder-input').click();
        });
        $('vcs-file-input').addEventListener('change', e => addFiles(e.target.files));
        $('vcs-folder-input').addEventListener('change', e => {
            const all = Array.from(e.target.files);
            if (all.length) addFiles(all);
        });

        // ── Bug #1: Global drag-drop overlay (works even when board is open) ──
        const overlay = document.getElementById('vcs-drop-overlay');
        let dragCounter = 0;
        document.addEventListener('dragenter', e => {
            if (!e.dataTransfer.types.includes('Files')) return;
            dragCounter++;
            if (dragCounter === 1) overlay.classList.add('is-visible');
        });
        document.addEventListener('dragleave', () => {
            dragCounter--;
            if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('is-visible'); }
        });
        document.addEventListener('dragover', e => e.preventDefault());
        document.addEventListener('drop', e => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.remove('is-visible');
            $('vcs-dropzone').classList.remove('is-dragover');
            if (e.dataTransfer.items) {
                const files = [], promises = [];
                for (let i = 0; i < e.dataTransfer.items.length; i++) {
                    const entry = e.dataTransfer.items[i].webkitGetAsEntry();
                    if (entry) promises.push(traverseFileTree(entry, files));
                }
                Promise.all(promises).then(() => { if (files.length) addFiles(files); });
            } else {
                addFiles(e.dataTransfer.files);
            }
        });

        // ── Bitrate chips ───────────────────────────────────────
        document.querySelectorAll('.vcs-chip').forEach(chip => {
            chip.addEventListener('click', e => {
                document.querySelectorAll('.vcs-chip').forEach(c => {
                    c.classList.remove('is-active');
                    c.setAttribute('aria-checked', 'false');
                    c.setAttribute('tabindex', '-1');
                });
                e.target.classList.add('is-active');
                e.target.setAttribute('aria-checked', 'true');
                e.target.setAttribute('tabindex', '0');
                STATE.settings.bitrate = e.target.dataset.q;
                $('vcs-custom-br').style.display = STATE.settings.bitrate === 'custom' ? 'inline-block' : 'none';
                updateTotalEstimate();
                saveSettings();
            });
        });

        // ── Preset tab buttons ──────────────────────────────────
        document.querySelectorAll('.vcs-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                syncTabHighlight(tab.dataset.preset);
                $('vcs-preset').value = tab.dataset.preset;
                applyPreset(tab.dataset.preset);
                updateTotalEstimate();
            });
        });

        // ── Settings change handlers ────────────────────────────
        ['vcs-format', 'vcs-preset', 'vcs-custom-br', 'vcs-vbr', 'vcs-normalize',
         'vcs-samplerate', 'vcs-channels', 'vcs-template', 'vcs-merge'].forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('change', () => {
                updateStateFromUI();
                saveSettings();
                // Polish #15: sync tabs when dropdown changes
                if (id === 'vcs-preset') {
                    const v = $('vcs-preset').value;
                    syncTabHighlight(v);
                    applyPreset(v);
                }
                updateTotalEstimate();
            });
            el.addEventListener('input', () => { updateStateFromUI(); saveSettings(); updateTotalEstimate(); });
        });

        // ── Per-file trim ───────────────────────────────────────
        ['vcs-trim-start', 'vcs-trim-end'].forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('input', () => { updateSelectedFileTrim(); saveSettings(); });
            el.addEventListener('change', () => { updateSelectedFileTrim(); saveSettings(); });
        });

        $('vcs-set-start-btn').addEventListener('click', () => {
            const player = $('vcs-preview-player');
            if (player && STATE.selectedFileId) {
                $('vcs-trim-start').value = player.currentTime.toFixed(3);
                updateSelectedFileTrim();
                saveSettings();
            }
        });
        $('vcs-set-end-btn').addEventListener('click', () => {
            const player = $('vcs-preview-player');
            if (player && STATE.selectedFileId) {
                $('vcs-trim-end').value = player.currentTime.toFixed(3);
                updateSelectedFileTrim();
                saveSettings();
            }
        });

        // ── Conversion buttons ──────────────────────────────────
        $('vcs-convert-btn').addEventListener('click', startConversion);
        $('vcs-cancel-btn').addEventListener('click', () => {
            STATE.cancelFlag = true;
            $('vcs-progress-text').textContent = 'Cancelled by user.';
            if (STATE.ffmpeg) { try { STATE.ffmpeg.terminate(); } catch(e){} STATE.ffmpeg = null; }
            $('vcs-convert-btn').disabled = false;
            $('vcs-cancel-btn').style.display = 'none';
        });
        $('vcs-log-toggle').addEventListener('click', () => {
            const log = $('vcs-log');
            const show = log.style.display !== 'block';
            log.style.display = show ? 'block' : 'none';
            $('vcs-log-toggle').textContent = show ? 'Hide Log' : 'Show Log';
            $('vcs-log-toggle').setAttribute('aria-expanded', show ? 'true' : 'false');
        });
        $('vcs-zip-btn').addEventListener('click', downloadZip);
        $('vcs-retry-btn').addEventListener('click', () => {
            STATE.files.forEach(f => { if (f.status === 'Failed') f.status = 'Ready'; });
            $('vcs-retry-btn').style.display = 'none';
            $('vcs-progress-fill').classList.remove('is-error');
            renderFileList();
            startConversion();
        });

        // ── UX #4: Clear All button ─────────────────────────────
        $('vcs-clear-btn').addEventListener('click', () => {
            if (!STATE.files.length) return;
            if (!confirm(`Clear all ${STATE.files.length} file(s) from the queue?`)) return;
            clearQueue();
        });

        // ── UX #7: Keyboard shortcuts ───────────────────────────
        document.addEventListener('keydown', e => {
            const tag = document.activeElement.tagName;
            const isInput = ['INPUT','SELECT','TEXTAREA'].includes(tag);
            // Enter → Convert (when not in input)
            if (e.key === 'Enter' && !isInput && !STATE.isConverting && STATE.files.length) {
                e.preventDefault();
                startConversion();
            }
            // Escape → Cancel
            if (e.key === 'Escape' && STATE.isConverting) {
                $('vcs-cancel-btn').click();
            }
            // Delete/Backspace → remove selected file
            if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput && STATE.selectedFileId) {
                e.preventDefault();
                removeFile(STATE.selectedFileId);
            }
            // Ctrl+O → open file picker
            if (e.ctrlKey && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                $('vcs-file-input').click();
            }
        });

        // ── Feature #10: Drag-to-reorder queue rows ─────────────
        // (delegated — attached in renderFileList per-row)
    }

    // ─────────────────────────────────────────────────────────────
    //  HELPERS
    // ─────────────────────────────────────────────────────────────
    function syncTabHighlight(preset) {
        document.querySelectorAll('.vcs-tab').forEach(t =>
            t.classList.toggle('is-active', t.dataset.preset === preset)
        );
    }

    function clearQueue() {
        STATE.files.forEach(f => {
            if (f.blobUrl) try { URL.revokeObjectURL(f.blobUrl); } catch(e){}
        });
        STATE.files = [];
        STATE.selectedFileId = null;
        const player = document.getElementById('vcs-preview-player');
        if (player) { player.src = ''; player.removeAttribute('data-vcs-dynamic-url'); }
        renderFileList();
        updateTotalEstimate();
        // Hide board, show dropzone
        document.getElementById('vcs-files-panel').classList.remove('is-shown');
        document.getElementById('vcs-settings-panel').classList.remove('is-shown');
        document.getElementById('vcs-preview-panel').classList.remove('is-shown');
        document.getElementById('vcs-main-layout').classList.remove('is-active');
        document.querySelector('.vcs-card').classList.remove('is-active');
        // Reset progress bar
        const prog = document.getElementById('vcs-progress');
        if (prog) prog.style.display = 'none';
    }

    function removeFile(id) {
        const item = STATE.files.find(x => x.id === id);
        if (item && item.blobUrl) try { URL.revokeObjectURL(item.blobUrl); } catch(e){}
        if (STATE.selectedFileId === id) {
            STATE.selectedFileId = null;
            const player = document.getElementById('vcs-preview-player');
            if (player) {
                if (player.dataset.vcsDynamicUrl) try { URL.revokeObjectURL(player.src); } catch(e){}
                player.src = '';
                player.removeAttribute('data-vcs-dynamic-url');
            }
        }
        STATE.files = STATE.files.filter(x => x.id !== id);
        renderFileList();
        updateTotalEstimate();
        if (STATE.files.length > 0) {
            if (!STATE.selectedFileId) selectFile(STATE.files[0].id);
        } else {
            clearQueue();
        }
    }

    function traverseFileTree(item, fileList, path = '') {
        return new Promise(resolve => {
            if (item.isFile) {
                item.file(file => { fileList.push(file); resolve(); });
            } else if (item.isDirectory) {
                const dirReader = item.createReader();
                const readEntries = () => {
                    dirReader.readEntries(entries => {
                        if (!entries.length) { resolve(); return; }
                        Promise.all(entries.map(e => traverseFileTree(e, fileList, path + item.name + '/'))).then(readEntries);
                    });
                };
                readEntries();
            } else { resolve(); }
        });
    }

    function updateStateFromUI() {
        const $ = id => document.getElementById(id);
        STATE.settings.format    = $('vcs-format').value;
        STATE.settings.preset    = $('vcs-preset').value;
        STATE.settings.customBitrate = $('vcs-custom-br').value;
        STATE.settings.vbr       = $('vcs-vbr').checked;
        STATE.settings.normalize = $('vcs-normalize').checked;
        STATE.settings.sampleRate= $('vcs-samplerate').value;
        STATE.settings.channels  = $('vcs-channels').value;
        STATE.settings.trimStart = $('vcs-trim-start').value;
        STATE.settings.trimEnd   = $('vcs-trim-end').value;
        STATE.settings.filenameTemplate = $('vcs-template').value;
        STATE.settings.mergeToOne = $('vcs-merge').checked;
        updateConvertBtnLabel();
    }

    function updateConvertBtnLabel() {
        const btn = document.getElementById('vcs-convert-btn');
        if (!btn) return;
        const ready = STATE.files.filter(f => f.status === 'Ready' || f.status === 'Failed').length;
        const fmt   = STATE.settings.format.toUpperCase();
        if (STATE.settings.mergeToOne) {
            btn.textContent = `Merge & Convert (${ready})`;
        } else {
            btn.textContent = ready > 0 ? `Convert (${ready}) → ${fmt}` : `Convert All → ${fmt}`;
        }
    }

    // ── UX #8: load settings and sync tab highlight ─────────────
    function loadSettings() {
        const s = localStorage.getItem('vcs_settings');
        if (!s) return;
        try {
            const parsed = JSON.parse(s);
            Object.assign(STATE.settings, parsed);
            const $ = id => document.getElementById(id);
            $('vcs-format').value    = STATE.settings.format;
            $('vcs-preset').value    = STATE.settings.preset;
            $('vcs-custom-br').value = STATE.settings.customBitrate;
            $('vcs-vbr').checked     = STATE.settings.vbr;
            $('vcs-normalize').checked = STATE.settings.normalize;
            $('vcs-samplerate').value= STATE.settings.sampleRate;
            $('vcs-channels').value  = STATE.settings.channels;
            $('vcs-trim-start').value = STATE.settings.trimStart || '';
            $('vcs-trim-end').value   = STATE.settings.trimEnd || '';
            $('vcs-template').value   = STATE.settings.filenameTemplate || '{name}.{format}';
            $('vcs-merge').checked    = STATE.settings.mergeToOne || false;
            document.querySelectorAll('.vcs-chip').forEach(c => {
                const active = c.dataset.q === STATE.settings.bitrate;
                c.classList.toggle('is-active', active);
                c.setAttribute('aria-checked', active ? 'true' : 'false');
                c.setAttribute('tabindex', active ? '0' : '-1');
            });
            $('vcs-custom-br').style.display = STATE.settings.bitrate === 'custom' ? 'inline-block' : 'none';
            // UX #8: sync tab highlight with saved preset
            syncTabHighlight(STATE.settings.preset);
            updateStateFromUI();
        } catch(e) {}
    }

    function saveSettings() {
        localStorage.setItem('vcs_settings', JSON.stringify(STATE.settings));
    }

    function applyPreset(preset) {
        const p = {
            'Music':       { br: '192', format: 'mp3',  sr: '44100', ch: '2', norm: false, vbr: false },
            'Podcast':     { br: '128', format: 'mp3',  sr: '44100', ch: '1', norm: true,  vbr: false },
            'Voice':       { br: '64',  format: 'opus', sr: '22050', ch: '1', norm: true,  vbr: false },
            'Audiobook':   { br: '64',  format: 'm4a',  sr: '22050', ch: '1', norm: true,  vbr: false },
            'AI_Optimize': { br: '48',  format: 'mp3',  sr: '16000', ch: '1', norm: false, vbr: false },
            'AI_Video':    { br: '48',  format: 'mp4',  sr: '16000', ch: '1', norm: false, vbr: false },
        }[preset];
        if (p) {
            STATE.settings.preset    = preset;
            STATE.settings.format    = p.format;
            STATE.settings.bitrate   = p.br;
            STATE.settings.sampleRate= p.sr;
            STATE.settings.channels  = p.ch;
            STATE.settings.normalize = p.norm;
            STATE.settings.vbr       = p.vbr;
            saveSettings();
            loadSettings();
        }
    }

    function probeDuration(file) {
        return new Promise(resolve => {
            const el = document.createElement('video');
            el.preload = 'metadata'; el.muted = true; el.playsInline = true;
            let url;
            try { url = URL.createObjectURL(file); } catch(e) { resolve(0); return; }
            const done = () => {
                el.onloadedmetadata = el.onerror = null;
                try { URL.revokeObjectURL(url); } catch(e){}
                try { el.src = ''; el.load(); } catch(e){}
            };
            el.onloadedmetadata = () => { const d = el.duration; done(); resolve(d || 0); };
            el.onerror = () => { done(); resolve(0); };
            setTimeout(() => { done(); resolve(0); }, 2000);
            el.src = url;
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  ADD FILES
    // ─────────────────────────────────────────────────────────────
    function addFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        document.getElementById('vcs-files-panel').classList.add('is-shown');
        document.getElementById('vcs-settings-panel').classList.add('is-shown');
        document.getElementById('vcs-main-layout').classList.add('is-active');
        document.querySelector('.vcs-card').classList.add('is-active');

        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            const ext  = PURE.pickExtension(file.name);
            const type = file.type || '';
            const isMedia = type.startsWith('video/') || type.startsWith('audio/') ||
                ['mp4','mkv','avi','mov','webm','mp3','wav','m4a','ogg','opus','flac'].includes(ext);
            if (!isMedia) { logMsg(`Skipping non-media: ${file.name}`); continue; }

            // Dedup by name + size
            if (STATE.files.some(x => x.file.name === file.name && x.file.size === file.size)) {
                logMsg(`Skipped duplicate: ${file.name}`); continue;
            }

            const item = {
                file, id: Math.random().toString(36).substr(2, 9),
                status: 'Ready', duration: 0,
                blobUrl: null, blobData: null, outName: '',
                trimStart: '', trimEnd: '',
                isAudioOnly: PURE.isAudioOnly(file)
            };
            STATE.files.push(item);
            probeDuration(file).then(dur => { item.duration = dur; updateTotalEstimate(); });
        }
        renderFileList();
        updateTotalEstimate();
        if (STATE.files.length > 0 && !STATE.selectedFileId) {
            selectFile(STATE.files[0].id);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  RENDER FILE LIST
    // ─────────────────────────────────────────────────────────────
    function renderFileList() {
        const list = document.getElementById('vcs-file-list');
        list.innerHTML = '';
        const fmt = STATE.settings.format.toUpperCase();

        STATE.files.forEach((f, idx) => {
            const row = document.createElement('div');
            row.className = 'vcs-file-row' + (f.id === STATE.selectedFileId ? ' is-selected' : '');
            row.setAttribute('draggable', 'true');
            row.dataset.id = f.id;

            const statusClass = f.status === 'Done' ? 'is-done'
                : f.status === 'Failed' ? 'is-failed'
                : f.status.startsWith('Converting') ? 'is-converting' : '';

            // Polish #17: format badge | Feature #14: per-row download button
            const downloadBtn = (f.status === 'Done' && f.blobUrl)
                ? `<button class="vcs-dl-btn" data-id="${f.id}" title="Download ${f.outName}" aria-label="Download ${escapeHTML(f.outName)}">↓</button>`
                : '';

            // Custom trim indicator
            const hasTrim = f.trimStart || f.trimEnd;
            const trimBadge = hasTrim ? `<span class="vcs-trim-badge" title="Custom trim set">✂</span>` : '';

            row.innerHTML = `
                <span class="vcs-file-num">#${idx + 1}</span>
                <span class="vcs-file-name" title="${escapeHTML(f.file.name)}">${escapeHTML(f.file.name)}</span>
                ${trimBadge}
                <span class="vcs-file-fmt">${fmt}</span>
                <span class="vcs-file-actions">
                    <span class="vcs-file-status ${statusClass}">${f.status}</span>
                    ${downloadBtn}
                    <button class="vcs-remove-btn" data-id="${f.id}" title="Remove" aria-label="Remove ${escapeHTML(f.file.name)}">×</button>
                </span>
            `;
            list.appendChild(row);
        });

        // Queue header: live count breakdown (UX #6)
        const done   = STATE.files.filter(f => f.status === 'Done').length;
        const failed = STATE.files.filter(f => f.status === 'Failed').length;
        const ready  = STATE.files.filter(f => f.status === 'Ready').length;
        const title  = document.querySelector('#vcs-files-panel .vcs-block-title');
        if (title) {
            const parts = [];
            if (ready)  parts.push(`${ready} ready`);
            if (done)   parts.push(`${done} done`);
            if (failed) parts.push(`${failed} failed`);
            title.textContent = `Queue (${STATE.files.length})${parts.length ? '  ·  ' + parts.join(' · ') : ''}`;
        }

        // Clear button visibility (UX #4)
        const clearBtn = document.getElementById('vcs-clear-btn');
        if (clearBtn) clearBtn.style.display = STATE.files.length ? 'inline-block' : 'none';

        // Update convert button label (UX #5)
        updateConvertBtnLabel();

        // ── Wire row events ──────────────────────────────────────
        list.querySelectorAll('.vcs-file-row').forEach((row, idx) => {
            // Select on click
            row.addEventListener('click', e => {
                if (e.target.closest('.vcs-remove-btn') || e.target.closest('.vcs-dl-btn')) return;
                const item = STATE.files[idx];
                if (item) selectFile(item.id);
            });

            // Feature #10: Drag to reorder
            row.addEventListener('dragstart', e => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.dataset.id);
                row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
            row.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Show drop indicator
                const rect = row.getBoundingClientRect();
                const mid  = rect.top + rect.height / 2;
                row.classList.toggle('drag-above', e.clientY < mid);
                row.classList.toggle('drag-below', e.clientY >= mid);
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-above', 'drag-below');
            });
            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('drag-above', 'drag-below');
                const fromId = e.dataTransfer.getData('text/plain');
                const toId   = row.dataset.id;
                if (fromId === toId) return;
                const fromIdx = STATE.files.findIndex(x => x.id === fromId);
                const toIdx   = STATE.files.findIndex(x => x.id === toId);
                if (fromIdx < 0 || toIdx < 0) return;
                const [moved] = STATE.files.splice(fromIdx, 1);
                STATE.files.splice(toIdx, 0, moved);
                renderFileList();
            });
        });

        // Remove buttons
        list.querySelectorAll('.vcs-remove-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); removeFile(btn.dataset.id); });
        });

        // Feature #14: Per-row download button
        list.querySelectorAll('.vcs-dl-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const item = STATE.files.find(x => x.id === btn.dataset.id);
                if (item && item.blobUrl) {
                    const a = document.createElement('a');
                    a.href = item.blobUrl; a.download = item.outName;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                }
            });
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  ESTIMATE + SIZE WARNING
    // ─────────────────────────────────────────────────────────────
    function updateTotalEstimate() {
        let totalDuration = 0, hasDuration = false;
        STATE.files.forEach(f => {
            if (f.duration > 0) {
                let start = parseFloat(f.trimStart) || 0;
                let end   = parseFloat(f.trimEnd);
                if (isNaN(end) || end <= 0) end = f.duration;
                totalDuration += Math.max(0, Math.min(f.duration, end) - start);
                hasDuration = true;
            }
        });
        if (!hasDuration && STATE.files.length > 0) totalDuration = STATE.files.length * 200;

        let br = STATE.settings.bitrate === 'custom'
            ? parseInt(STATE.settings.customBitrate, 10)
            : parseInt(STATE.settings.bitrate, 10);
        if (isNaN(br) || !br) br = 192;

        // If it's AI_Video, add a rough 50kbps overhead for the 1/2 FPS video track
        if (STATE.settings.preset === 'AI_Video') br += 50;

        const estMiB = PURE.estimateMiB(totalDuration, br);
        const estEl  = document.getElementById('vcs-est');
        if (!estEl) return;

        // Feature #12: size warning against AI limits
        let warning = '';
        if (estMiB > 200) {
            warning = `<span class="vcs-est-warn is-over">⚠ Exceeds NotebookLM 200MB limit</span>`;
        }
        estEl.innerHTML = `Estimated output: ~${PURE.formatBytes(estMiB)} ${warning}`;
    }

    // ─────────────────────────────────────────────────────────────
    //  SELECT FILE  (Bug #2: audio-only handling)
    // ─────────────────────────────────────────────────────────────
    function selectFile(id) {
        STATE.selectedFileId = id;
        const list = document.getElementById('vcs-file-list');
        if (list) {
            list.querySelectorAll('.vcs-file-row').forEach(row => {
                row.classList.toggle('is-selected', row.dataset.id === id);
            });
        }
        const item = STATE.files.find(x => x.id === id);
        if (!item) return;

        document.getElementById('vcs-preview-panel').classList.add('is-shown');

        const player    = document.getElementById('vcs-preview-player');
        const audioPlaceholder = document.getElementById('vcs-audio-placeholder');
        const timeLabel = document.getElementById('vcs-preview-time');

        if (player && audioPlaceholder) {
            if (player.dataset.vcsDynamicUrl) try { URL.revokeObjectURL(player.src); } catch(e){}
            const fileUrl = URL.createObjectURL(item.file);
            player.dataset.vcsDynamicUrl = 'true';

            // Bug #2: audio-only shows audio placeholder, not broken video
            if (item.isAudioOnly) {
                player.style.display = 'none';
                audioPlaceholder.style.display = 'flex';
                audioPlaceholder.querySelector('.vcs-audio-name').textContent = item.file.name;
                // Still set player src for trim controls (audio element)
                player.src = fileUrl;
            } else {
                player.style.display = 'block';
                audioPlaceholder.style.display = 'none';
                player.src = fileUrl;
            }
        }
        if (timeLabel) timeLabel.textContent = `Selected: ${item.file.name}`;

        const startInput = document.getElementById('vcs-trim-start');
        const endInput   = document.getElementById('vcs-trim-end');
        if (startInput) startInput.value = item.trimStart;
        if (endInput)   endInput.value   = item.trimEnd;
    }

    function updateSelectedFileTrim() {
        if (!STATE.selectedFileId) return;
        const item = STATE.files.find(x => x.id === STATE.selectedFileId);
        if (!item) return;
        item.trimStart = document.getElementById('vcs-trim-start').value;
        item.trimEnd   = document.getElementById('vcs-trim-end').value;
        updateTotalEstimate();
        renderFileList(); // refresh trim badge
    }

    function logMsg(msg) {
        const l = document.getElementById('vcs-log');
        if (l) { l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; }
    }

    // ─────────────────────────────────────────────────────────────
    //  FFMPEG INIT
    // ─────────────────────────────────────────────────────────────
    async function initFFmpeg() {
        if (STATE.ffmpeg) return STATE.ffmpeg;
        if (!window.FFmpegWASM) throw new Error('FFmpeg script not loaded');
        const { FFmpeg } = window.FFmpegWASM;
        const { toBlobURL } = window.FFmpegUtil;
        const ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => logMsg(message));
        logMsg('Loading FFmpeg core...');
        await ffmpeg.load({
            coreURL: await toBlobURL('ffmpeg-core.js', 'text/javascript'),
            wasmURL: await toBlobURL('ffmpeg-core.wasm', 'application/wasm')
        });
        STATE.ffmpeg = ffmpeg;
        return ffmpeg;
    }

    // ─────────────────────────────────────────────────────────────
    //  CONVERSION  (Bug #3: skip Done, Polish #16: persistent bar)
    // ─────────────────────────────────────────────────────────────
    async function startConversion() {
        if (STATE.files.length === 0) return;

        // Bug #3: only convert Ready (or Failed if retried) — skip Done
        const convertQueue = STATE.files.filter(f => f.status === 'Ready');
        if (convertQueue.length === 0) {
            logMsg('Nothing to convert — all files are already done.');
            return;
        }

        // Feature #13: request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        STATE.isConverting = true;
        STATE.cancelFlag   = false;

        const convertBtn   = document.getElementById('vcs-convert-btn');
        const cancelBtn    = document.getElementById('vcs-cancel-btn');
        const progressPanel= document.getElementById('vcs-progress');
        const progressText = document.getElementById('vcs-progress-text');
        const progressFill = document.getElementById('vcs-progress-fill');

        convertBtn.disabled = true;
        cancelBtn.style.display  = 'inline-block';
        progressPanel.style.display = 'block';
        progressFill.classList.remove('is-error');
        progressFill.style.width = '0%';
        
        const throttleWarn = document.getElementById('vcs-throttle-warn');
        if (throttleWarn) throttleWarn.style.display = 'block';

        let doneCount = 0, failCount = 0;
        const usedNames = new Set();
        const { fetchFile } = window.FFmpegUtil;

        try {
            const ffmpeg = await initFFmpeg();

            if (STATE.settings.mergeToOne && convertQueue.length > 1) {
                // ── Merge mode ───────────────────────────────────
                progressText.textContent = 'Merging all files...';
                try {
                    let inputs = [], filterStr = '';
                    const fmt = STATE.settings.format;
                    const outName = 'merged_output.' + fmt;
                    for (let i = 0; i < convertQueue.length; i++) {
                        if (STATE.cancelFlag) break;
                        const item = convertQueue[i];
                        item.status = 'Converting (Merge)...';
                        renderFileList();
                        const ext = PURE.pickExtension(item.file.name);
                        const inName = `input_${i}.${ext || 'bin'}`;
                        await ffmpeg.writeFile(inName, await fetchFile(item.file));
                        inputs.push('-i', inName);
                        filterStr += `[${i}:a]`;
                    }
                    if (!STATE.cancelFlag) {
                        filterStr += `concat=n=${convertQueue.length}:v=0:a=1[out]`;
                        const args = [...inputs, '-filter_complex', filterStr, '-map', '[out]'];
                        if (STATE.settings.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
                        args.push('-ar', STATE.settings.sampleRate, '-ac', STATE.settings.channels);
                        let br = STATE.settings.bitrate === 'custom' ? STATE.settings.customBitrate : STATE.settings.bitrate;
                        if (!br) br = '192';
                        if (STATE.settings.vbr && ['mp3','m4a','ogg'].includes(fmt)) args.push('-q:a', '2');
                        else if (!['wav','flac'].includes(fmt)) args.push('-b:a', br + 'k');
                        args.push(outName);
                        ffmpeg.on('progress', ({ progress }) => {
                            const c = PURE.clampProgress(progress);
                            progressFill.style.width = (c * 100) + '%';
                            progressText.textContent = `Merging: ${(c * 100).toFixed(0)}%`;
                        });
                        await ffmpeg.exec(args);
                        const data = await ffmpeg.readFile(outName);
                        const blob = new Blob([data.buffer], { type: fmt === 'mp4' ? 'video/mp4' : 'audio/' + fmt });
                        const blobUrl = URL.createObjectURL(blob);
                        convertQueue.forEach(item => {
                            item.status = 'Done'; item.blobUrl = blobUrl;
                            item.outName = outName; item.blobData = blob; doneCount++;
                        });
                        renderFileList();
                        triggerDownload(blobUrl, outName);
                        await ffmpeg.deleteFile(outName);
                    }
                    for (let i = 0; i < convertQueue.length; i++) {
                        const ext = PURE.pickExtension(convertQueue[i].file.name);
                        try { await ffmpeg.deleteFile(`input_${i}.${ext || 'bin'}`); } catch(e){}
                    }
                } catch(err) {
                    logMsg('Merge error: ' + err.message);
                    convertQueue.forEach(item => { item.status = 'Failed'; failCount++; });
                    renderFileList();
                }
            } else {
                // ── Individual conversion ─────────────────────────
                for (let index = 0; index < convertQueue.length; index++) {
                    if (STATE.cancelFlag) break;
                    const item = convertQueue[index];
                    item.status = 'Converting...';
                    renderFileList();
                    progressText.textContent = `Converting ${item.file.name}...`;

                    const startTime = Date.now();
                    ffmpeg.on('progress', ({ progress }) => {
                        const fp = PURE.clampProgress(progress);
                        const overall = (index + fp) / convertQueue.length;
                        progressFill.style.width = (overall * 100) + '%';

                        let etaStr = '';
                        if (fp > 0.001) { // Show ETA after just 0.1% instead of 1%
                            const elapsed = Date.now() - startTime;
                            const total = elapsed / fp;
                            const remaining = Math.max(0, total - elapsed);
                            const rSecs = Math.round(remaining / 1000);
                            const m = Math.floor(rSecs / 60);
                            const s = rSecs % 60;
                            etaStr = ` - ~${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} left`;
                        }

                        // Show 1 decimal place so they can see tiny amounts of progress on huge files
                        progressText.textContent = `Converting ${index + 1}/${convertQueue.length}: ${item.file.name} (${(fp * 100).toFixed(1)}%)${etaStr}`;
                    });

                    const ext    = PURE.pickExtension(item.file.name);
                    const inName = `input_${item.id}.${ext || 'bin'}`;
                    const fmt    = STATE.settings.format;
                    const outBase = PURE.sanitizeFilename(item.file.name, usedNames).replace('.mp3', '');
                    let outName = STATE.settings.filenameTemplate
                        .replace('{name}', outBase)
                        .replace('{bitrate}', STATE.settings.bitrate)
                        .replace('{format}', fmt)
                        .replace('{date}', new Date().toISOString().split('T')[0]);
                    if (!outName.endsWith('.' + fmt)) outName += '.' + fmt;
                    usedNames.add(outName);

                    try {
                        await ffmpeg.writeFile(inName, await fetchFile(item.file));
                        const args = ['-threads', '1'];
                        if (fmt === 'mp4' && STATE.settings.preset === 'AI_Video' && !item.isAudioOnly) {
                            // Safely skip non-keyframes to massively speed up decoding
                            args.push('-skip_frame', 'nokey');
                        }
                        args.push('-i', inName);
                        if (item.trimStart) args.push('-ss', item.trimStart);
                        if (item.trimEnd)   args.push('-to', item.trimEnd);
                        if (STATE.settings.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
                        args.push('-ar', STATE.settings.sampleRate, '-ac', STATE.settings.channels);
                        let br = STATE.settings.bitrate === 'custom' ? STATE.settings.customBitrate : STATE.settings.bitrate;
                        if (!br) br = '192';

                        if (fmt === 'mp4' && !item.isAudioOnly) {
                            if (STATE.settings.preset === 'AI_Video') {
                                // Smart scaling, MJPEG codec, and VFR to prevent memory buffering crashes on massive files
                                args.push('-vf', 'scale=-2:\'min(ih,720)\'', '-r', '1', '-vsync', '2', '-c:v', 'mjpeg', '-q:v', '5');
                            } else {
                                args.push('-c:v', 'copy');
                            }
                        }

                        if (STATE.settings.vbr && ['mp3','m4a','ogg'].includes(fmt)) args.push('-q:a', '2');
                        else if (!['wav','flac','mp4'].includes(fmt)) args.push('-b:a', br + 'k');
                        else if (fmt === 'mp4') args.push('-b:a', br + 'k'); // mp4 uses aac by default usually, needs bitrate

                        args.push(outName);
                        await ffmpeg.exec(args);
                        const data = await ffmpeg.readFile(outName);
                        const blob = new Blob([data.buffer], { type: fmt === 'mp4' ? 'video/mp4' : 'audio/' + fmt });
                        item.blobUrl  = URL.createObjectURL(blob);
                        item.outName  = outName;
                        item.blobData = blob;
                        item.status   = 'Done';
                        doneCount++;
                        triggerDownload(item.blobUrl, outName);
                        await ffmpeg.deleteFile(outName);
                    } catch(err) {
                        let errMsg = err.message || err.toString();
                        if (errMsg === '[object Object]' || !err.message) {
                            errMsg = "Memory Crash (File too large for browser RAM)";
                        }
                        logMsg('Error on ' + item.file.name + ': ' + errMsg);
                        item.status = 'Failed'; failCount++;
                    } finally {
                        try { await ffmpeg.deleteFile(inName); } catch(e){}
                    }
                    renderFileList();
                }
            }
        } catch(err) {
            logMsg('Fatal Engine Error: ' + err.message);
            if (STATE.ffmpeg) { try { STATE.ffmpeg.terminate(); } catch(e){} }
            STATE.ffmpeg = null;
        }

        STATE.isConverting = false;
        convertBtn.disabled = false;
        cancelBtn.style.display = 'none';
        const throttleWarnEnd = document.getElementById('vcs-throttle-warn');
        if (throttleWarnEnd) throttleWarnEnd.style.display = 'none';

        // Polish #16: persistent progress bar with final result
        progressFill.style.width = '100%';
        if (STATE.cancelFlag) {
            progressText.textContent = 'Cancelled.';
            progressFill.style.width = '0%';
        } else {
            const msg = failCount > 0
                ? `${doneCount} converted · ${failCount} failed`
                : `✓ ${doneCount} file${doneCount !== 1 ? 's' : ''} converted`;
            progressText.textContent = msg;
            if (failCount > 0) {
                progressFill.classList.add('is-error');
                document.getElementById('vcs-retry-btn').style.display = 'inline-block';
            }
            if (STATE.files.some(f => f.status === 'Done')) {
                document.getElementById('vcs-zip-btn').style.display = 'inline-block';
            }
            // Feature #13: OS notification
            sendNotification(msg);
        }
        renderFileList();
    }

    function triggerDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }

    // Feature #13: OS notification
    function sendNotification(msg) {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'granted') {
            try { new Notification('VideoConv', { body: msg, icon: '' }); } catch(e){}
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  ZIP DOWNLOAD
    // ─────────────────────────────────────────────────────────────
    async function downloadZip() {
        if (typeof JSZip === 'undefined') { logMsg('JSZip not loaded'); return; }
        logMsg('Packaging ZIP...');
        const zip = new JSZip();
        STATE.files.forEach(f => { if (f.status === 'Done' && f.blobData) zip.file(f.outName, f.blobData); });
        try {
            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            triggerDownload(url, 'converted_audio.zip');
            logMsg('ZIP download triggered.');
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch(err) { logMsg('ZIP failed: ' + err.message); }
    }
})();
