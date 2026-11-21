// 识别并移除 HLS 媒体播放列表中插播的广告段（浏览器与 Node 共用）
(function (root) {
    const MAX_AD_BLOCK_SECONDS = 300;
    const MIN_MAIN_SHARE = 0.5;
    const MAX_SHORT_AD_SECONDS = 60;
    const SHORT_BLOCK_RATIO = 0.1;

    function resolve(uri, baseUrl) {
        try {
            return new URL(uri, baseUrl).toString();
        } catch (e) {
            return uri;
        }
    }

    // 只比较末尾几级目录：同一部片常分布在多个镜像域名上，且镜像可能多一层路径前缀
    function directoryOf(url) {
        let path = url.split(/[?#]/)[0];
        try {
            path = new URL(url).pathname;
        } catch (e) {
            // 保留原始字符串
        }
        return path.split('/').slice(0, -1).slice(-3).join('/');
    }

    function blockSeconds(block) {
        return block.segments.reduce((sum, segment) => sum + segment.duration, 0);
    }

    function median(values) {
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function absolutizeTag(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => `URI="${resolve(uri, baseUrl)}"`);
    }

    function parse(content, baseUrl) {
        const header = [];
        const footer = [];
        const blocks = [];
        let current = null;
        let duration = 0;

        for (const raw of content.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;

            if (line === '#EXT-X-DISCONTINUITY') {
                current = { lines: [line], segments: [] };
                blocks.push(current);
                continue;
            }
            if (line === '#EXT-X-ENDLIST') {
                footer.push(line);
                continue;
            }
            if (!current) {
                if (line.startsWith('#') && !line.startsWith('#EXTINF')) {
                    header.push(line);
                    continue;
                }
                current = { lines: [], segments: [] };
                blocks.push(current);
            }

            current.lines.push(line);
            if (line.startsWith('#EXTINF')) {
                duration = parseFloat(line.slice(8)) || 0;
            } else if (!line.startsWith('#')) {
                current.segments.push({ url: resolve(line, baseUrl), duration });
            }
        }

        return { header, footer, blocks: blocks.filter((block) => block.segments.length) };
    }

    function mainDirectory(blocks) {
        const totals = new Map();
        let all = 0;
        for (const block of blocks) {
            for (const segment of block.segments) {
                const dir = directoryOf(segment.url);
                totals.set(dir, (totals.get(dir) || 0) + segment.duration);
                all += segment.duration;
            }
        }
        let best = null;
        let bestTotal = 0;
        for (const [dir, total] of totals) {
            if (total > bestTotal) {
                best = dir;
                bestTotal = total;
            }
        }
        return all > 0 && bestTotal / all >= MIN_MAIN_SHARE ? best : null;
    }

    // 两类插播：来自其他目录的短段；或与正片同目录、但远短于其余段落的夹片
    function isAdBlock(block, mainDir, typicalSeconds) {
        const seconds = blockSeconds(block);
        if (mainDir) {
            const foreign = block.segments.filter((segment) => directoryOf(segment.url) !== mainDir).length;
            if (foreign * 2 > block.segments.length && seconds <= MAX_AD_BLOCK_SECONDS) {
                return true;
            }
        }
        return typicalSeconds > 0 && seconds <= MAX_SHORT_AD_SECONDS && seconds < typicalSeconds * SHORT_BLOCK_RATIO;
    }

    /**
     * @param {string} content 媒体播放列表文本
     * @param {string} baseUrl 播放列表自身地址，用于解析相对路径
     * @param {{absolute?: boolean}} options absolute 为 true 时把分片和 KEY 地址改写为绝对地址
     */
    function filterPlaylist(content, baseUrl, options = {}) {
        const result = { content, removedSegments: 0, removedSeconds: 0, removedBlocks: [] };
        if (!content || !content.includes('#EXTINF')) {
            return result;
        }

        const { header, footer, blocks } = parse(content, baseUrl);
        const mainDir = mainDirectory(blocks);
        const typicalSeconds = blocks.length > 1 ? median(blocks.map(blockSeconds)) : 0;
        const out = header.slice();
        let lastKey = header.filter((line) => line.startsWith('#EXT-X-KEY')).pop() || null;
        let keyDirty = false;

        for (const block of blocks) {
            if (isAdBlock(block, mainDir, typicalSeconds)) {
                result.removedSegments += block.segments.length;
                result.removedSeconds += blockSeconds(block);
                result.removedBlocks.push({ url: block.segments[0].url, seconds: blockSeconds(block) });
                keyDirty = keyDirty || block.lines.some((line) => line.startsWith('#EXT-X-KEY'));
                continue;
            }

            const lines = block.lines.slice();
            const startsWithBreak = lines[0] === '#EXT-X-DISCONTINUITY';
            const hasSegmentsBefore = out.some((line) => line.startsWith('#EXTINF'));
            if (startsWithBreak && !hasSegmentsBefore) {
                lines.shift();
            } else if (!startsWithBreak && hasSegmentsBefore) {
                lines.unshift('#EXT-X-DISCONTINUITY');
            }

            const firstSegment = lines.findIndex((line) => line.startsWith('#EXTINF'));
            const ownKey = lines.slice(0, firstSegment).some((line) => line.startsWith('#EXT-X-KEY'));
            if (keyDirty && !ownKey) {
                lines.splice(firstSegment, 0, lastKey || '#EXT-X-KEY:METHOD=NONE');
            }
            keyDirty = false;

            for (const line of lines) {
                if (line.startsWith('#EXT-X-KEY')) lastKey = line;
                out.push(line);
            }
        }

        out.push(...footer);

        const finalLines = options.absolute
            ? out.map((line) => {
                if (!line.startsWith('#')) return resolve(line, baseUrl);
                if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) return absolutizeTag(line, baseUrl);
                return line;
            })
            : out;

        result.content = finalLines.join('\n') + '\n';
        return result;
    }

    root.LibreTVAdFilter = { filterPlaylist };
})(typeof globalThis !== 'undefined' ? globalThis : window);
