let RELAY_URL = 'wss://nos.lol/';

// helper for retrieving the currently selected relay from the UI
const getRelayUrl = () => {
    const input = document.getElementById('relay');
    return input && input.value.trim() ? input.value.trim() : RELAY_URL;
};

async function checkRelay(url) {
    try {
        const relay = NostrTools.relayInit(url);
        await relay.connect();
        relay.close();
        return true;
    } catch (e) {
        console.warn(`[Relay Check] ${url} に接続できませんでした。`, e);
        return false;
    }
}

// initial relay check/fallback is performed once DOM is ready and the input has been populated
// we also populate the relay input with the default value so users can override it.
document.addEventListener('DOMContentLoaded', async () => {
    const relayInput = document.getElementById('relay');
    if (relayInput) {
        relayInput.value = RELAY_URL;
    }
    const isMainAlive = await checkRelay(getRelayUrl());
    if (!isMainAlive) {
        console.warn(`[Relay Fallback] nostr.band が死んでるので nos.lol に切り替えます。`);
        RELAY_URL = 'wss://relay.damus.io/';
        if (relayInput) {
            relayInput.value = RELAY_URL;
        }
    }
});
let fetchedPosts = [];
const reactionCache = new Map();
const postElements = new Map();
const reactionUpdateInterval = 5000;
async function resolveNip05(nip05) {
    const parts = nip05.split('@');
    if (parts.length !== 2) return null;
    const [name, domain] = parts;
    try {
        const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
        const data = await response.json();
        return data.names[name] || null
    } catch (e) {
        console.error(`NIP-05アドレスの解決に失敗しました: ${nip05}`, e);
        return null
    }
}
async function normalizePubkey(input) {
    if (input.startsWith("npub1")) {
        try {
            const {
                type,
                data
            } = NostrTools.nip19.decode(input);
            if (type === 'npub') {
                return data
            }
        } catch (e) {
            console.error("npubのデコードに失敗しました:", e);
            return null
        }
    } else if (/^[a-f0-9]{64}$/i.test(input)) {
        return input
    } else if (input.includes('@')) {
        return await resolveNip05(input)
    }
    return null
}
const renderPostsAndReactions = (posts, reactions, isInitialDraw) => {
    const postList = document.getElementById("post-list");
    const statusMessage = document.getElementById("status");
    const reactionCounts = {};
    reactions.forEach(reaction => {
        const targetEventId = reaction.tags.find(tag => tag[0] === 'e')?.[1];
        if (targetEventId) {
            if (!reactionCounts[targetEventId]) {
                reactionCounts[targetEventId] = {
                    reposts: 0,
                    reactions: 0
                }
            }
            if (reaction.kind === 6) {
                reactionCounts[targetEventId].reposts++
            } else if (reaction.kind === 7) {
                reactionCounts[targetEventId].reactions++
            }
        }
    });
    if (isInitialDraw) {
        fetchedPosts = posts;
        postList.innerHTML = '';
        postElements.clear();
        if (posts.length === 0) {
            statusMessage.textContent = '指定された日付の投稿は見つかりませんでした。';
            return
        }
        posts.sort((a, b) => a.created_at - b.created_at);
        console.log(`[Rendering] 投稿 ${posts.length} 件を初回描画します。`);
        posts.forEach(post => {
            const postElement = document.createElement('div');
            postElement.className = 'post';
            postElement.dataset.eventId = post.id;
            const postDate = new Date(post.created_at * 1000);
            const formattedDate = `${(postDate.getMonth() + 1).toString().padStart(2, '0')}/${postDate.getDate().toString().padStart(2, '0')} ${postDate.getHours().toString().padStart(2, '0')}:${postDate.getMinutes().toString().padStart(2, '0')}`;
            const eventPointer = {
                id: post.id,
                relays: [getRelayUrl()],
                author: post.pubkey,
            };
            const nevent = NostrTools.nip19.neventEncode(eventPointer);
            const customViewerUrl = `/tweetsrecap/tweet?id=${nevent}`;
            postElement.innerHTML = ` <div class="post-line"> <a href="${customViewerUrl}" target="_blank" class="post-time">[${formattedDate}]</a> ${linkifyAndEscapeHtml(post.content)} <span class="reaction-counts"></span> </div> `;
            postList.appendChild(postElement);
            postElements.set(post.id, postElement)
        })
    }
    posts.forEach(post => {
        const counts = reactionCounts[post.id] || {
            reposts: 0,
            reactions: 0
        };
        const postElement = postElements.get(post.id);
        if (postElement) {
            const reactionSpan = postElement.querySelector('.reaction-counts');
            if (reactionSpan) {
                reactionSpan.innerHTML = (counts.reactions > 0 || counts.reposts > 0) ? ` ${counts.reactions > 0 ? ` ⭐${counts.reactions}` : ''}${counts.reposts > 0 ? ` 🔁${counts.reposts}` : ''} ` : ''
            }
        }
    });
    statusMessage.textContent = `この日の投稿数：${posts.length}ツイート`
};
const searchPosts = async () => {
    const relayUrl = getRelayUrl();
    const npubInput = document.getElementById("npub").value.trim();
    const dateStr = document.getElementById("date").value;
    const statusMessage = document.getElementById("status");
    const summarizedPostsArea = document.getElementById("summarized-posts");
    document.getElementById("post-list").innerHTML = '';
    statusMessage.textContent = '検索中...';
    summarizedPostsArea.value = '';
    fetchedPosts = [];
    reactionCache.clear();
    postElements.clear();
    if (!npubInput || !dateStr) {
        statusMessage.textContent = 'npubまたはNIP-05アドレスと日付の両方を入力してください。';
        return
    }
    let pubkey;
    try {
        pubkey = await normalizePubkey(npubInput);
        if (!pubkey) {
            throw new Error('無効なnpub、NIP-05アドレス、または公開鍵形式です。')
        }
    } catch (e) {
        statusMessage.textContent = e.message;
        return
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
        statusMessage.textContent = '無効な日付形式です。';
        return
    }
    const sinceTime = Math.floor(date.setHours(0, 0, 0, 0) / 1000);
    const untilTime = Math.floor(date.setHours(23, 59, 59, 999) / 1000);
    console.log(`[Step 1] リレー ${relayUrl} から kind:1, 42 のイベントを検索します...`);
    try {
        const kinds1And42Events = await fetchPosts(relayUrl, pubkey, sinceTime, untilTime);
        const eventIds = kinds1And42Events.map(e => e.id);
        renderPostsAndReactions(kinds1And42Events, [], true);
        if (eventIds.length > 0) {
            fetchReactionsInBackground(relayUrl, pubkey, eventIds, sinceTime, untilTime)
        }
    } catch (e) {
        statusMessage.textContent = `エラーが発生しました: ${e.message}`;
        console.error('[Fatal Error]', e)
    }
};
const fetchPosts = async (relayUrl, pubkey, sinceTime, untilTime) => {
    const events = [];
    try {
        const relay = NostrTools.relayInit(relayUrl);
        await relay.connect();
        const sub = relay.sub([{
            kinds: [1, 42],
            authors: [pubkey],
            since: sinceTime,
            until: untilTime,
        }]);
        return new Promise((resolve, reject) => {
            sub.on('event', (event) => {
                events.push(event)
            });
            sub.on('eose', () => {
                relay.close();
                console.log(`[FetchPosts] 投稿の検索が完了しました。投稿数: ${events.length}件。`);
                resolve(events)
            });
            setTimeout(() => {
                relay.close();
                resolve(events)
            }, 5000)
        })
    } catch (e) {
        console.error(`[FetchPosts] リレー ${relayUrl} への接続または購読に失敗しました:`, e);
        return events
    }
};

const fetchReactionsInBackground = async (relayUrl, pubkey, eventIds, sinceTime, untilTime) => {

    const untilNow = Math.floor(Date.now() / 1000);

    try {
        const reactionRelay = NostrTools.relayInit(relayUrl);
        await reactionRelay.connect();

        const sub = reactionRelay.sub([{
            kinds: [6, 7],
            '#e': eventIds,
            since: sinceTime,
            until: untilNow,
        }]);

        sub.on('event', (event) => {
            reactionCache.set(event.id, event);
        });

        sub.on('eose', () => {
            reactionRelay.close();
            renderPostsAndReactions(
                fetchedPosts,
                Array.from(reactionCache.values()),
                false
            );
            console.log(`[Background] リアクション取得完了`);
        });

    } catch (e) {
        console.error(`[Background] リアクション取得失敗`, e);
    }
};

const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML
};
document.addEventListener('DOMContentLoaded', () => {
    const dateInput = document.getElementById('date');
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    dateInput.value = `${year}-${month}-${day}`
});
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const npubFromUrl = urlParams.get('npub');
    const dateFromUrl = urlParams.get('date');
    const relayFromUrl = urlParams.get('relay');
    if (npubFromUrl) {
        document.getElementById("npub").value = npubFromUrl;
    }
    if (dateFromUrl) {
        document.getElementById("date").value = dateFromUrl;
    }
    if (relayFromUrl) {
        const relayInput = document.getElementById('relay');
        if (relayInput) relayInput.value = relayFromUrl;
    }
    if (npubFromUrl && dateFromUrl) {
        searchPosts()
    }
});
const createShareLink = () => {
    const relay = document.getElementById("relay").value;
    const npub = document.getElementById("npub").value;
    const date = document.getElementById("date").value;
    if (!npub || !date) {
        alert("先にnpubと日付を入力してください。");
        return
    }
    let shareUrl = `${window.location.origin}${window.location.pathname}?npub=${encodeURIComponent(npub)}&date=${encodeURIComponent(date)}`;
    if (relay) {
        shareUrl += `&relay=${encodeURIComponent(relay)}`;
    }
    navigator.clipboard.writeText(shareUrl).then(() => {
        alert('シェアリンクをコピーしました！')
    }).catch(err => {
        console.error('コピーに失敗しました:', err)
    })
};
const summarizePosts = () => {
    const summarizedPostsArea = document.getElementById("summarized-posts");
    if (fetchedPosts.length === 0) {
        alert("先にツイートを表示してください。");
        return
    }
    const summary = fetchedPosts.map(post => {
        const postDate = new Date(post.created_at * 1000);
        const formattedDate = `${postDate.getFullYear()}/${(postDate.getMonth() + 1).toString().padStart(2, '0')}/${postDate.getDate().toString().padStart(2, '0')} ${postDate.getHours().toString().padStart(2, '0')}:${postDate.getMinutes().toString().padStart(2, '0')}:${postDate.getSeconds().toString().padStart(2, '0')}`;
        return `[${formattedDate}]\n${post.content}`
    }).join('\n---\n');
    summarizedPostsArea.value = summary
};
const copySummarizedPosts = () => {
    const text = document.getElementById("summarized-posts").value;
    if (!text.trim()) {
        alert("先にまとめてください。");
        return
    }
    navigator.clipboard.writeText(text).then(() => {
        alert('まとめをコピーしました！')
    }).catch(err => {
        console.error('コピーに失敗しました:', err)
    })
};
const linkifyAndEscapeHtml = (text) => {
    const escapedText = escapeHtml(text);
    const urlRegex = /\b(https?:\/\/[^\s]+)/g;
    return escapedText.replace(urlRegex, (url) => {
        const imageExtensions = /\.(png|jpe?g|gif|webp|svg|heic|avif)$/i;
        if (imageExtensions.test(url)) {
            return `<a href="#" onclick="event.preventDefault(); openModal('${url}')">${url}</a>`
        }
        return `<a href="${url}" target="_blank">${url}</a>`
    })
};