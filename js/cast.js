// 投屏到电视（DLNA）：由本机服务发现电视并下发播放地址，电视直接拉流播放
(function () {
    const LAST_DEVICE_KEY = 'castLastDevice';
    const state = { device: null, pollTimer: null, paused: false, position: 0 };

    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
        const response = await fetch(path, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `请求失败（${response.status}）`);
        }
        return data;
    }

    function formatTime(seconds) {
        const total = Math.max(0, Math.floor(seconds || 0));
        const m = Math.floor(total / 60);
        const s = String(total % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    function setModalVisible(visible) {
        $('castModal').classList.toggle('hidden', !visible);
        $('castModal').classList.toggle('flex', visible);
    }

    function renderDevices(devices) {
        const list = $('castDeviceList');
        const lastId = localStorage.getItem(LAST_DEVICE_KEY);

        if (!devices.length) {
            list.innerHTML = `
                <div class="text-center text-gray-400 py-6 text-sm leading-6">
                    没有找到电视。<br>
                    请确认电视已开机、和电脑在同一个网络，<br>
                    然后点「重新搜索」。
                </div>`;
            return;
        }

        list.innerHTML = '';
        for (const device of devices) {
            const button = document.createElement('button');
            button.className = 'w-full text-left px-4 py-3 mb-2 rounded-lg border transition-colors '
                + (device.id === lastId
                    ? 'border-[#00ccff] bg-[#0f2533]'
                    : 'border-[#333] bg-[#1a1a1a] hover:border-[#00ccff]');
            button.innerHTML = `
                <div class="font-medium text-white"></div>
                <div class="text-xs text-gray-400 mt-1"></div>`;
            button.children[0].textContent = device.name;
            button.children[1].textContent = device.host;
            button.addEventListener('click', () => startCast(device));
            list.appendChild(button);
        }
    }

    async function loadDevices(refresh) {
        const list = $('castDeviceList');
        list.innerHTML = '<div class="text-center text-gray-400 py-6 text-sm">正在搜索家里的电视…</div>';
        try {
            const { devices } = await api(`/api/cast/devices${refresh ? '?refresh=1' : ''}`);
            renderDevices(devices);
        } catch (error) {
            list.innerHTML = '';
            const message = document.createElement('div');
            message.className = 'text-center text-red-400 py-6 text-sm';
            message.textContent = error.message;
            list.appendChild(message);
        }
    }

    function openCastModal() {
        if (!currentVideoUrl) {
            showToast('当前没有可投屏的视频');
            return;
        }
        setModalVisible(true);
        loadDevices(false);
    }

    function localPosition() {
        return dp && dp.video ? dp.video.currentTime : 0;
    }

    function episodeTitle() {
        const total = currentEpisodes.length;
        return total > 1 ? `${currentVideoTitle} 第${currentEpisodeIndex + 1}集` : currentVideoTitle;
    }

    async function sendCurrent(position) {
        return api('/api/cast/play', {
            method: 'POST',
            body: JSON.stringify({
                deviceId: state.device.id,
                url: currentVideoUrl,
                title: episodeTitle(),
                position,
                adFilter: localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false',
                episodes: currentEpisodes,
                index: currentEpisodeIndex,
                seriesTitle: currentVideoTitle,
                autoNext: autoplayEnabled,
            }),
        });
    }

    async function startCast(device) {
        setModalVisible(false);
        state.device = device;
        state.paused = false;
        localStorage.setItem(LAST_DEVICE_KEY, device.id);
        showBar(`正在投到 ${device.name}…`);

        try {
            const result = await sendCurrent(localPosition());
            if (dp && dp.video) {
                dp.pause();
            }
            updateBar();
            startPolling();
            showToast(result.adFiltered ? '已投到电视（已去广告），手机可以锁屏了' : '已投到电视，手机可以锁屏了');
        } catch (error) {
            state.device = null;
            hideBar();
            showToast(`投屏失败：${error.message}`);
        }
    }

    async function control(action, seconds) {
        if (!state.device) {
            return;
        }
        try {
            await api('/api/cast/control', {
                method: 'POST',
                body: JSON.stringify({ deviceId: state.device.id, action, seconds }),
            });
            if (action === 'pause') state.paused = true;
            if (action === 'resume') state.paused = false;
            updateBar();
        } catch (error) {
            showToast(error.message);
        }
    }

    async function stopCast() {
        const device = state.device;
        stopPolling();
        state.device = null;
        hideBar();
        if (device) {
            await api('/api/cast/control', {
                method: 'POST',
                body: JSON.stringify({ deviceId: device.id, action: 'stop' }),
            }).catch(() => {});
        }
        if (dp && dp.video && state.position > 0) {
            dp.seek(state.position);
        }
        showToast('已停止投屏');
    }

    function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(async () => {
            if (!state.device) return;
            try {
                const info = await api(`/api/cast/status?deviceId=${encodeURIComponent(state.device.id)}`);
                if (typeof info.index === 'number' && info.index !== currentEpisodeIndex) {
                    followTvEpisode(info.index);
                }
                state.position = info.position;
                state.paused = info.state === 'PAUSED_PLAYBACK';
                $('castTime').textContent = info.duration
                    ? `${formatTime(info.position)} / ${formatTime(info.duration)}`
                    : formatTime(info.position);
                updateBar();
            } catch {
                // 电视短暂没有响应时保持上一次的状态
            }
        }, 3000);
    }

    function stopPolling() {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    function showBar(text) {
        $('castBar').classList.remove('hidden');
        $('castStatusText').textContent = text;
        $('castTime').textContent = '';
    }

    function hideBar() {
        $('castBar').classList.add('hidden');
    }

    function updateBar() {
        if (!state.device) return;
        $('castStatusText').textContent = `电视播放中：${state.device.name}`;
        $('castPauseBtn').textContent = state.paused ? '继续' : '暂停';
    }

    let switchEpisodeLocally = null;

    function keepLocalPaused() {
        if (!dp || !dp.video) return;
        dp.pause();
        dp.video.addEventListener('playing', () => {
            if (state.device) dp.pause();
        }, { once: true });
    }

    // 电视已由服务端自动换到下一集，页面只同步显示，不再重新投屏
    function followTvEpisode(index) {
        if (!switchEpisodeLocally || index < 0 || index >= currentEpisodes.length) return;
        switchEpisodeLocally(index);
        keepLocalPaused();
        showToast(`电视已自动播放第${index + 1}集`);
    }

    function wrapEpisodeSwitch() {
        const original = window.playEpisode;
        if (typeof original !== 'function') return;
        switchEpisodeLocally = original;
        window.playEpisode = function (index) {
            original(index);
            if (state.device) {
                keepLocalPaused();
                showBar(`正在切换到第${index + 1}集…`);
                sendCurrent(0)
                    .then(() => updateBar())
                    .catch((error) => showToast(`换集投屏失败：${error.message}`));
            }
        };
    }

    document.addEventListener('DOMContentLoaded', () => {
        $('castOpenBtn').addEventListener('click', openCastModal);
        $('castCloseBtn').addEventListener('click', () => setModalVisible(false));
        $('castRefreshBtn').addEventListener('click', () => loadDevices(true));
        $('castPauseBtn').addEventListener('click', () => control(state.paused ? 'resume' : 'pause'));
        $('castBackBtn').addEventListener('click', () => control('seek', state.position - 30));
        $('castForwardBtn').addEventListener('click', () => control('seek', state.position + 30));
        $('castStopBtn').addEventListener('click', stopCast);
        $('castModal').addEventListener('click', (event) => {
            if (event.target.id === 'castModal') setModalVisible(false);
        });
        wrapEpisodeSwitch();
    });
})();
