import { createWriteStream } from 'fs';
import { get as httpGet } from 'http';
import { get as httpsGet } from 'https';

export async function downloadImage(url: string, filename: string): Promise<void> {
    const writer = createWriteStream(filename);
    const client = url.startsWith('https') ? httpsGet : httpGet;

    return new Promise((resolve, reject) => {
        client(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
                return;
            }
            res.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        }).on('error', reject);
    });
}