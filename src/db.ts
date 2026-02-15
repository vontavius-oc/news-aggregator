import sqlite3 from 'sqlite3';
import { promisify } from 'util';

export interface Post {
    id?: number;
    source: string;
    title: string;
    link: string;
    postLink?: string;
    createdAt?: string;
}

export interface Media {
    id?: number;
    postId: number;
    type: string;
    remoteUrl: string;
    localPath?: string;
}

export class Database {
    private db: sqlite3.Database;

    constructor(dbPath: string) {
        this.db = new sqlite3.Database(dbPath);
    }

    async init() {
        return new Promise<void>((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS posts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        source TEXT NOT NULL,
                        title TEXT NOT NULL,
                        link TEXT NOT NULL UNIQUE,
                        post_link TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `, (err) => { if (err) reject(err); });

                this.db.run(`
                    CREATE TABLE IF NOT EXISTS media (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        post_id INTEGER NOT NULL,
                        type TEXT NOT NULL,
                        remote_url TEXT NOT NULL,
                        local_path TEXT,
                        FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
                    )
                `, (err) => { 
                    if (err) reject(err); 
                    else resolve();
                });
            });
        });
    }

    async insertPost(post: Post): Promise<number | null> {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO posts (source, title, link, post_link) VALUES (?, ?, ?, ?)`,
                [post.source, post.title, post.link, post.postLink],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID > 0 ? this.lastID : null);
                }
            );
        });
    }

    async getPostIdByLink(link: string): Promise<number | null> {
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT id FROM posts WHERE link = ?`, [link], (err, row: any) => {
                if (err) reject(err);
                else resolve(row ? row.id : null);
            });
        });
    }

    async insertMedia(media: Media): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO media (post_id, type, remote_url, local_path) VALUES (?, ?, ?, ?)`,
                [media.postId, media.type, media.remoteUrl, media.localPath],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    close() {
        this.db.close();
    }
}
