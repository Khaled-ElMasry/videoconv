(function () {
    const STATE = {
        files: [],
        selectedFileId: null,
        isConverting: false,
        cancelFlag: false,
        ffmpeg: null,
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
                if (typeof existingSet.add === 'function') {
                    existingSet.add(finalName);
                }
            }
            return finalName;
        },
        estimateMiB: (sec, kbps) => {
            const s = parseFloat(sec);
            const k = parseFloat(kbps);
            return isNaN(s) || isNaN(k) || s <= 0 || k <= 0 ? 0 : (s * k) / 8192;
        },
        clampProgress: p => isNaN(p) || p < 0 ? 0 : (p > 1 ? 1 : p),
        pickExtension: name => {
            const parts = name.split('.');
            return parts.length > 1 ? parts.pop().toLowerCase() : '';
        },
        formatBytes: mib => {
            const m = parseFloat(mib);
            if (isNaN(m) || m <= 0) return '0.0 KiB';
            if (m < 1) return (m * 1024).toFixed(1) + ' KiB';
            if (m < 1024) return m.toFixed(1) + ' MiB';
            return (m / 1024).toFixed(2) + ' GiB';
        }
    };

    // Ensure DOM is ready
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }
    }

    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    function initApp() {
        bindEvents();
        loadSettings();
        checkSharedArrayBuffer();
    }

    function checkSharedArrayBuffer() {
        if (typeof SharedArrayBuffer === 'undefined') {
            logMsg('Warning: SharedArrayBuffer is not available. Single-threaded mode will be slower.');
            logMsg('To enable multi-threaded processing, please serve this website with Cross-Origin Opener Policy (COOP) and Cross-Origin Embedder Policy (COEP) headers.');
        }
    }

    function bindEvents() {
        const $ = id => document.getElementById(id);
        
        $('vcs-dropzone').addEventListener('click', e => {
            if (e.target.id === 'vcs-select-folder-btn') {
                e.stopPropagation();
                $('vcs-folder-input').click();
            } else if (e.target.id === 'vcs-select-files-btn' || e.target.closest('#vcs-dropzone')) {
                $('vcs-file-input').click();
            }
        });

        $('vcs-dropzone').addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                $('vcs-file-input').click();
            }
        });

        $('vcs-file-input').addEventListener('change', e => addFiles(e.target.files));
        $('vcs-folder-input').addEventListener('change', e => addFiles(e.target.files));
        
        $('vcs-dropzone').addEventListener('dragover', e => {
            e.preventDefault();
            $('vcs-dropzone').classList.add('is-dragover');
        });
        $('vcs-dropzone').addEventListener('dragleave', () => {
            $('vcs-dropzone').classList.remove('is-dragover');
        });
        $('vcs-dropzone').addEventListener('drop', e => {
            e.preventDefault();
            $('vcs-dropzone').classList.remove('is-dragover');
            if (e.dataTransfer.items) {
                // Read files recursively if items are directories
                const files = [];
                const promises = [];
                for (let i = 0; i < e.dataTransfer.items.length; i++) {
                    const item = e.dataTransfer.items[i].webkitGetAsEntry();
                    if (item) {
                        promises.push(traverseFileTree(item, files));
                    }
                }
                Promise.all(promises).then(() => {
                    if (files.length > 0) addFiles(files);
                });
            } else {
                addFiles(e.dataTransfer.files);
            }
        });

        document.querySelectorAll('.vcs-chip').forEach(chip => {
            chip.addEventListener('click', e => {
                document.querySelectorAll('.vcs-chip').forEach(c => {
                    c.classList.remove('is-active');
                    c.setAttribute('aria-checked', 'false');
                });
                e.target.classList.add('is-active');
                e.target.setAttribute('aria-checked', 'true');
                STATE.settings.bitrate = e.target.dataset.q;
                $('vcs-custom-br').style.display = STATE.settings.bitrate === 'custom' ? 'inline-block' : 'none';
                updateTotalEstimate();
                saveSettings();
            });
        });

        ['vcs-format', 'vcs-preset', 'vcs-custom-br', 'vcs-vbr', 'vcs-normalize', 'vcs-samplerate', 'vcs-channels', 'vcs-template', 'vcs-merge'].forEach(id => {
            const el = $(id);
            if (el) {
                el.addEventListener('change', () => {
                    updateStateFromUI();
                    saveSettings();
                    if (id === 'vcs-preset') applyPreset($('vcs-preset').value);
                    updateTotalEstimate();
                });
                el.addEventListener('input', () => {
                    updateStateFromUI();
                    saveSettings();
                    updateTotalEstimate();
                });
            }
        });

        ['vcs-trim-start', 'vcs-trim-end'].forEach(id => {
            const el = $(id);
            if (el) {
                el.addEventListener('input', () => {
                    updateSelectedFileTrim();
                    saveSettings();
                });
                el.addEventListener('change', () => {
                    updateSelectedFileTrim();
                    saveSettings();
                });
            }
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

        $('vcs-convert-btn').addEventListener('click', startConversion);
        $('vcs-cancel-btn').addEventListener('click', () => {
            STATE.cancelFlag = true;
            $('vcs-progress-text').textContent = 'Cancelled by user.';
            if (STATE.ffmpeg) {
                try { STATE.ffmpeg.terminate(); } catch(e){}
                STATE.ffmpeg = null;
            }
            $('vcs-convert-btn').disabled = false;
            $('vcs-cancel-btn').style.display = 'none';
        });
        
        $('vcs-log-toggle').addEventListener('click', () => {
            const log = $('vcs-log');
            const show = log.style.display !== 'block';
            log.style.display = show ? 'block' : 'none';
            $('vcs-log-toggle').textContent = show ? 'Hide Log' : 'Show Log';
        });

        $('vcs-zip-btn').addEventListener('click', downloadZip);

        $('vcs-retry-btn').addEventListener('click', () => {
            STATE.files.forEach(f => { if (f.status === 'Failed') f.status = 'Ready'; });
            $('vcs-retry-btn').style.display = 'none';
            $('vcs-progress-fill').classList.remove('is-error');
            renderFileList();
            startConversion();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                $('vcs-file-input').click();
            }
            if (e.key === 'Escape' && STATE.isConverting) {
                $('vcs-cancel-btn').click();
            }
        });
    }

    // Traverse directory trees for dropped folders
    function traverseFileTree(item, fileList, path = '') {
        return new Promise((resolve) => {
            if (item.isFile) {
                item.file(file => {
                    fileList.push(file);
                    resolve();
                });
            } else if (item.isDirectory) {
                const dirReader = item.createReader();
                const readEntries = () => {
                    dirReader.readEntries(entries => {
                        if (entries.length === 0) {
                            resolve();
                        } else {
                            const promises = entries.map(entry => traverseFileTree(entry, fileList, path + item.name + '/'));
                            Promise.all(promises).then(() => resolve());
                        }
                    });
                };
                readEntries();
            } else {
                resolve();
            }
        });
    }

    function updateStateFromUI() {
        const $ = id => document.getElementById(id);
        STATE.settings.format = $('vcs-format').value;
        STATE.settings.preset = $('vcs-preset').value;
        STATE.settings.customBitrate = $('vcs-custom-br').value;
        STATE.settings.vbr = $('vcs-vbr').checked;
        STATE.settings.normalize = $('vcs-normalize').checked;
        STATE.settings.sampleRate = $('vcs-samplerate').value;
        STATE.settings.channels = $('vcs-channels').value;
        STATE.settings.trimStart = $('vcs-trim-start').value;
        STATE.settings.trimEnd = $('vcs-trim-end').value;
        STATE.settings.filenameTemplate = $('vcs-template').value;
        STATE.settings.mergeToOne = $('vcs-merge').checked;

        // Dynamic Convert All button text matching chosen format
        $('vcs-convert-btn').textContent = STATE.settings.mergeToOne 
            ? `Merge & Convert to ${STATE.settings.format.toUpperCase()}`
            : `Convert All to ${STATE.settings.format.toUpperCase()}`;
    }

    function loadSettings() {
        const s = localStorage.getItem('vcs_settings');
        if (!s) return;
        try {
            const parsed = JSON.parse(s);
            Object.assign(STATE.settings, parsed);
            const $ = id => document.getElementById(id);
            
            $('vcs-format').value = STATE.settings.format;
            $('vcs-preset').value = STATE.settings.preset;
            $('vcs-custom-br').value = STATE.settings.customBitrate;
            $('vcs-vbr').checked = STATE.settings.vbr;
            $('vcs-normalize').checked = STATE.settings.normalize;
            $('vcs-samplerate').value = STATE.settings.sampleRate;
            $('vcs-channels').value = STATE.settings.channels;
            $('vcs-trim-start').value = STATE.settings.trimStart || '';
            $('vcs-trim-end').value = STATE.settings.trimEnd || '';
            $('vcs-template').value = STATE.settings.filenameTemplate || '{name}.{format}';
            $('vcs-merge').checked = STATE.settings.mergeToOne || false;

            document.querySelectorAll('.vcs-chip').forEach(c => {
                c.classList.remove('is-active');
                c.setAttribute('aria-checked', 'false');
                if (c.dataset.q === STATE.settings.bitrate) {
                    c.classList.add('is-active');
                    c.setAttribute('aria-checked', 'true');
                }
            });
            $('vcs-custom-br').style.display = STATE.settings.bitrate === 'custom' ? 'inline-block' : 'none';
            updateStateFromUI();
        } catch(e) {}
    }

    function saveSettings() {
        localStorage.setItem('vcs_settings', JSON.stringify(STATE.settings));
    }

    function applyPreset(preset) {
        const p = {
            'Music': { br: '192', format: 'mp3', sr: '44100', ch: '2', norm: false },
            'Podcast': { br: '128', format: 'mp3', sr: '44100', ch: '1', norm: true },
            'Voice': { br: '64', format: 'opus', sr: '22050', ch: '1', norm: true },
            'Audiobook': { br: '64', format: 'm4a', sr: '22050', ch: '1', norm: true }
        }[preset];
        if (p) {
            STATE.settings.format = p.format;
            STATE.settings.bitrate = p.br;
            STATE.settings.sampleRate = p.sr;
            STATE.settings.channels = p.ch;
            STATE.settings.normalize = p.norm;
            saveSettings();
            loadSettings(); // update UI
        }
    }

    function probeDuration(file) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            
            let url;
            try {
                url = URL.createObjectURL(file);
            } catch (e) {
                resolve(0);
                return;
            }
            
            const done = () => {
                video.onloadedmetadata = null;
                video.onerror = null;
                try {
                    URL.revokeObjectURL(url);
                } catch(e){}
                try {
                    video.src = '';
                    video.load();
                } catch(e){}
            };
            
            video.onloadedmetadata = () => {
                const dur = video.duration;
                done();
                resolve(dur || 0);
            };
            
            video.onerror = () => {
                done();
                resolve(0);
            };
            
            setTimeout(() => {
                done();
                resolve(0);
            }, 2000);
            
            video.src = url;
        });
    }

    function addFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        
        document.getElementById('vcs-files-panel').classList.add('is-shown');
        document.getElementById('vcs-settings-panel').classList.add('is-shown');
        
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            
            const ext = PURE.pickExtension(file.name);
            const type = file.type || '';
            const isMedia = type.startsWith('video/') || type.startsWith('audio/') || ['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac'].includes(ext);
            if (!isMedia) {
                logMsg(`Skipping non-media file: ${file.name}`);
                continue;
            }

            const item = {
                file: file,
                id: Math.random().toString(36).substr(2, 9),
                status: 'Ready',
                duration: 0,
                blobUrl: null,
                blobData: null,
                outName: '',
                trimStart: '',
                trimEnd: ''
            };
            STATE.files.push(item);
            
            probeDuration(file).then(dur => {
                item.duration = dur;
                updateTotalEstimate();
            });
        }
        renderFileList();
        updateTotalEstimate();

        if (STATE.files.length > 0 && !STATE.selectedFileId) {
            selectFile(STATE.files[0].id);
        }
    }

    function renderFileList() {
        const list = document.getElementById('vcs-file-list');
        list.innerHTML = '';
        STATE.files.forEach(f => {
            const row = document.createElement('div');
            row.className = 'vcs-file-row' + (f.id === STATE.selectedFileId ? ' is-selected' : '');
            row.innerHTML = `
                <span class="vcs-file-name" title="${escapeHTML(f.file.name)}">${escapeHTML(f.file.name)}</span>
                <span>
                    <span class="vcs-file-status ${f.status === 'Done' ? 'is-done' : (f.status === 'Failed' ? 'is-failed' : (f.status.startsWith('Converting') ? 'is-converting' : ''))}">${f.status}</span>
                    ${f.blobUrl ? `<audio src="${f.blobUrl}" controls style="height:24px; width:150px; vertical-align:middle; margin-left:10px;"></audio>` : ''}
                    <button class="vcs-remove-btn" data-id="${f.id}" title="Remove file">×</button>
                </span>
            `;
            list.appendChild(row);
        });
        
        const rows = list.querySelectorAll('.vcs-file-row');
        rows.forEach((row, idx) => {
            row.addEventListener('click', e => {
                if (e.target.classList.contains('vcs-remove-btn') || e.target.closest('.vcs-remove-btn')) return;
                const item = STATE.files[idx];
                if (item) {
                    selectFile(item.id);
                }
            });
        });

        document.querySelectorAll('.vcs-remove-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const id = e.target.dataset.id;
                const item = STATE.files.find(x => x.id === id);
                if (item && item.blobUrl) {
                    try { URL.revokeObjectURL(item.blobUrl); } catch(err){}
                }

                if (STATE.selectedFileId === id) {
                    STATE.selectedFileId = null;
                    const player = document.getElementById('vcs-preview-player');
                    if (player) {
                        if (player.dataset.vcsDynamicUrl) {
                            try { URL.revokeObjectURL(player.src); } catch(e){}
                        }
                        player.src = '';
                        player.removeAttribute('data-vcs-dynamic-url');
                    }
                }
                
                STATE.files = STATE.files.filter(x => x.id !== id);
                renderFileList();
                updateTotalEstimate();
                if (STATE.files.length > 0) {
                    if (!STATE.selectedFileId) {
                        selectFile(STATE.files[0].id);
                    }
                } else {
                    document.getElementById('vcs-files-panel').classList.remove('is-shown');
                    document.getElementById('vcs-settings-panel').classList.remove('is-shown');
                    document.getElementById('vcs-preview-panel').classList.remove('is-shown');
                }
            });
        });
    }

    function updateTotalEstimate() {
        let totalDuration = 0;
        let hasDuration = false;
        STATE.files.forEach(f => {
            if (f.duration > 0) {
                let start = parseFloat(f.trimStart);
                let end = parseFloat(f.trimEnd);
                if (isNaN(start)) start = 0;
                if (isNaN(end) || end <= 0) end = f.duration;
                let activeDur = Math.max(0, Math.min(f.duration, end) - start);
                
                totalDuration += activeDur;
                hasDuration = true;
            }
        });
        
        if (!hasDuration && STATE.files.length > 0) {
            totalDuration = STATE.files.length * 200;
        }
        
        let br = STATE.settings.bitrate === 'custom' ? parseInt(STATE.settings.customBitrate, 10) : parseInt(STATE.settings.bitrate, 10);
        if (isNaN(br) || !br) br = 192;
        
        const estMiB = PURE.estimateMiB(totalDuration, br);
        const formatted = PURE.formatBytes(estMiB);
        const estEl = document.getElementById('vcs-est');
        if (estEl) {
            estEl.textContent = `Estimated total output: ~${formatted}`;
        }
    }

    function selectFile(id) {
        STATE.selectedFileId = id;
        
        const list = document.getElementById('vcs-file-list');
        if (list) {
            const rows = list.querySelectorAll('.vcs-file-row');
            STATE.files.forEach((f, idx) => {
                if (rows[idx]) {
                    if (f.id === id) {
                        rows[idx].classList.add('is-selected');
                    } else {
                        rows[idx].classList.remove('is-selected');
                    }
                }
            });
        }
        
        const item = STATE.files.find(x => x.id === id);
        if (!item) return;

        const previewPanel = document.getElementById('vcs-preview-panel');
        if (previewPanel) {
            previewPanel.classList.add('is-shown');
        }
        
        const player = document.getElementById('vcs-preview-player');
        const timeLabel = document.getElementById('vcs-preview-time');
        
        if (player) {
            if (player.dataset.vcsDynamicUrl) {
                try { URL.revokeObjectURL(player.src); } catch(e){}
            }
            const fileUrl = URL.createObjectURL(item.file);
            player.src = fileUrl;
            player.dataset.vcsDynamicUrl = 'true';
        }
        
        if (timeLabel) {
            timeLabel.textContent = `Selected: ${item.file.name}`;
        }
        
        const startInput = document.getElementById('vcs-trim-start');
        const endInput = document.getElementById('vcs-trim-end');
        if (startInput) startInput.value = item.trimStart;
        if (endInput) endInput.value = item.trimEnd;
    }

    function updateSelectedFileTrim() {
        if (STATE.selectedFileId) {
            const item = STATE.files.find(x => x.id === STATE.selectedFileId);
            if (item) {
                item.trimStart = document.getElementById('vcs-trim-start').value;
                item.trimEnd = document.getElementById('vcs-trim-end').value;
                updateTotalEstimate();
            }
        }
    }

    function logMsg(msg) {
        const l = document.getElementById('vcs-log');
        if (l) {
            if (l.textContent === undefined || l.textContent === null) l.textContent = '';
            l.textContent += msg + '\n';
            l.scrollTop = l.scrollHeight;
        }
    }

    async function initFFmpeg() {
        if (STATE.ffmpeg) return STATE.ffmpeg;
        if (!window.FFmpegWASM) throw new Error("FFmpeg script not loaded");
        const { FFmpeg } = window.FFmpegWASM;
        const { toBlobURL } = window.FFmpegUtil;
        const ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => logMsg(message));
        
        logMsg('Loading FFmpeg core...');
        
        const coreOptions = {
            coreURL: await toBlobURL('ffmpeg-core.js', 'text/javascript'),
            wasmURL: await toBlobURL('ffmpeg-core.wasm', 'application/wasm')
        };
        
        if (typeof SharedArrayBuffer === 'undefined') {
            logMsg('SharedArrayBuffer not available. Loading Single-Threaded Core.');
        }
        
        await ffmpeg.load(coreOptions);
        STATE.ffmpeg = ffmpeg;
        return ffmpeg;
    }

    async function startConversion() {
        if (STATE.files.length === 0) return;
        
        const convertQueue = STATE.files.filter(f => f.status === 'Ready');
        if (convertQueue.length === 0) return;

        STATE.isConverting = true;
        STATE.cancelFlag = false;
        
        const convertBtn = document.getElementById('vcs-convert-btn');
        const cancelBtn = document.getElementById('vcs-cancel-btn');
        const progressPanel = document.getElementById('vcs-progress');
        const progressText = document.getElementById('vcs-progress-text');
        const progressFill = document.getElementById('vcs-progress-fill');
        
        convertBtn.disabled = true;
        cancelBtn.style.display = 'inline-block';
        progressPanel.style.display = 'block';
        progressFill.classList.remove('is-error');
        progressFill.style.width = '0%';
        
        let doneCount = 0;
        let failCount = 0;
        const usedNames = new Set();
        const { fetchFile } = window.FFmpegUtil;
        
        try {
            const ffmpeg = await initFFmpeg();
            
            if (STATE.settings.mergeToOne && convertQueue.length > 1) {
                progressText.textContent = 'Merging all files...';
                try {
                    let inputs = [];
                    let filterStr = '';
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
                        args.push('-ar', STATE.settings.sampleRate);
                        args.push('-ac', STATE.settings.channels);
                        
                        let br = STATE.settings.bitrate === 'custom' ? STATE.settings.customBitrate : STATE.settings.bitrate;
                        if (!br) br = '192';
                        
                        if (STATE.settings.vbr && ['mp3', 'm4a', 'ogg'].includes(fmt)) {
                            args.push('-q:a', '2');
                        } else if (!['wav', 'flac'].includes(fmt)) {
                            args.push('-b:a', br + 'k');
                        }
                        args.push(outName);
                        
                        ffmpeg.on('progress', ({ progress }) => {
                            const clamped = PURE.clampProgress(progress);
                            progressFill.style.width = (clamped * 100) + '%';
                            progressText.textContent = `Merging: ${(clamped * 100).toFixed(0)}%`;
                        });

                        await ffmpeg.exec(args);
                        
                        const data = await ffmpeg.readFile(outName);
                        const blob = new Blob([data.buffer], { type: 'audio/' + fmt });
                        const blobUrl = URL.createObjectURL(blob);
                        
                        convertQueue.forEach(item => {
                            item.status = 'Done';
                            item.blobUrl = blobUrl;
                            item.outName = outName;
                            item.blobData = blob;
                            doneCount++;
                        });
                        renderFileList();
                        
                        const a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = outName;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        
                        await ffmpeg.deleteFile(outName);
                    }
                    
                    for (let i = 0; i < convertQueue.length; i++) {
                        const ext = PURE.pickExtension(convertQueue[i].file.name);
                        try { await ffmpeg.deleteFile(`input_${i}.${ext || 'bin'}`); } catch(err){}
                    }
                } catch (err) {
                    logMsg('Merge error: ' + err.message);
                    convertQueue.forEach(item => { item.status = 'Failed'; failCount++; });
                    renderFileList();
                }
            } else {
                for (let index = 0; index < convertQueue.length; index++) {
                    if (STATE.cancelFlag) break;
                    
                    const item = convertQueue[index];
                    item.status = 'Converting...';
                    renderFileList();
                    progressText.textContent = `Converting ${item.file.name}...`;
                    
                    ffmpeg.on('progress', ({ progress }) => {
                        const fileProgress = PURE.clampProgress(progress);
                        const overallProgress = (index + fileProgress) / convertQueue.length;
                        progressFill.style.width = (overallProgress * 100) + '%';
                        progressText.textContent = `Converting: ${item.file.name} (${(fileProgress * 100).toFixed(0)}%)`;
                    });

                    const ext = PURE.pickExtension(item.file.name);
                    const inName = `input_${item.id}.${ext || 'bin'}`;
                    const outBase = PURE.sanitizeFilename(item.file.name, usedNames).replace('.mp3', '');
                    const fmt = STATE.settings.format;
                    
                    let outName = STATE.settings.filenameTemplate
                        .replace('{name}', outBase)
                        .replace('{bitrate}', STATE.settings.bitrate)
                        .replace('{format}', fmt)
                        .replace('{date}', new Date().toISOString().split('T')[0]);
                    
                    if (!outName.endsWith('.' + fmt)) outName += '.' + fmt;
                    usedNames.add(outName);

                    try {
                        await ffmpeg.writeFile(inName, await fetchFile(item.file));
                        
                        const args = ['-i', inName];
                        if (item.trimStart) args.push('-ss', item.trimStart);
                        if (item.trimEnd) args.push('-to', item.trimEnd);
                        if (STATE.settings.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
                        
                        args.push('-ar', STATE.settings.sampleRate);
                        args.push('-ac', STATE.settings.channels);
                        
                        let br = STATE.settings.bitrate === 'custom' ? STATE.settings.customBitrate : STATE.settings.bitrate;
                        if (!br) br = '192';
                        
                        if (STATE.settings.vbr && ['mp3', 'm4a', 'ogg'].includes(fmt)) {
                            args.push('-q:a', '2');
                        } else if (!['wav', 'flac'].includes(fmt)) {
                            args.push('-b:a', br + 'k');
                        }
                        args.push(outName);
                        
                        await ffmpeg.exec(args);
                        
                        const data = await ffmpeg.readFile(outName);
                        const blob = new Blob([data.buffer], { type: 'audio/' + fmt });
                        item.blobUrl = URL.createObjectURL(blob);
                        item.outName = outName;
                        item.blobData = blob;
                        item.status = 'Done';
                        doneCount++;
                        
                        const a = document.createElement('a');
                        a.href = item.blobUrl;
                        a.download = outName;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        
                        await ffmpeg.deleteFile(outName);
                    } catch (err) {
                        logMsg('Error on ' + item.file.name + ': ' + err.message);
                        item.status = 'Failed';
                        failCount++;
                    } finally {
                        try { await ffmpeg.deleteFile(inName); } catch(err){}
                    }
                    
                    renderFileList();
                }
            }
        } catch (err) {
            logMsg('Fatal Engine Error: ' + err.message);
            if (STATE.ffmpeg) {
                try { STATE.ffmpeg.terminate(); } catch(e){}
            }
            STATE.ffmpeg = null;
        }
        
        STATE.isConverting = false;
        convertBtn.disabled = false;
        cancelBtn.style.display = 'none';
        
        if (STATE.cancelFlag) {
            progressText.textContent = 'Cancelled.';
        } else {
            progressText.textContent = `${doneCount} converted, ${failCount} failed.`;
            if (failCount > 0) {
                progressFill.classList.add('is-error');
                document.getElementById('vcs-retry-btn').style.display = 'inline-block';
            }
            const hasDones = STATE.files.some(f => f.status === 'Done');
            if (hasDones) {
                document.getElementById('vcs-zip-btn').style.display = 'inline-block';
            }
        }
    }

    async function downloadZip() {
        if (typeof JSZip === 'undefined') {
            logMsg('JSZip is not loaded');
            return;
        }
        logMsg('Packaging ZIP archive...');
        const zip = new JSZip();
        STATE.files.forEach(f => {
            if (f.status === 'Done' && f.blobData) {
                zip.file(f.outName, f.blobData);
            }
        });
        
        try {
            const content = await zip.generateAsync({ type: 'blob' });
            const blobUrl = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = 'converted_audio.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            logMsg('ZIP download triggered.');
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        } catch (err) {
            logMsg('ZIP generation failed: ' + err.message);
        }
    }
})();
