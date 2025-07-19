import { chromium, Page } from "playwright"
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import 'dotenv/config';
import { downloadImage } from './downloader.js';

const newAdPageUrl = 'https://hardverapro.hu/hirdetesfeladas/uj.php';
const args = process.argv.slice(2);
const browser = await chromium.launch({ headless: true }); // set headless to false if you want to see or debug the process
// Creating new context and page if any image has been cached in the browser from previous runs
const context = await browser.newContext({
    userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
});
const onePage = await context.newPage();

const isLoggedIn = async (page: Page): Promise<boolean> => {
    await page.goto(newAdPageUrl, { waitUntil: 'networkidle' });
    await getRidOfCookiePopup(page);
    await clearUploadedImages(page);

    return !(await page.content()).includes('Az oldal megtekintéséhez belépés szükséges');
}

const run = async (url: string, page: Page) => {
    await page.goto(url, { waitUntil: 'networkidle' });

    await getRidOfCookiePopup(page);

    //if the ad is expired, click on the "Megnézem" button
    for (const modal of await page.locator('.modal-body').all()) {
        const modalText = await modal.innerText();

        if (modalText.includes('Ez a hirdetés már lejárt!')) {
            modal.getByText('Megnézem').first().click();
            break;
        }
    }

    //get the title of the ad
    const title = (await page.locator('.uad-content-block').first().innerText()).replace('Archív – ', '').replace(/– \d+ megtekintés/, '').trim();


    //get the place of the ad
    const cityBlock = await page.locator('[class="uad-time-location"]').innerText();
    const isOnlyInPerson = cityBlock.includes('csak személyes átvétel');

    // get the category of the ad
    const categoryElements = (await page.locator('.breadcrumb li.breadcrumb-item').all()).splice(2);
    const categoryList = await Promise.all(
        categoryElements.map(async (item) => await item.innerText())
    );

    const details = page.locator('.uad-details');
    const price = (await details.locator('.col-md-4').first().innerText()).replace(/Ft|\s/g, '').trim();
    const table = details.getByRole('table');
    const condition = (await table.locator('td').nth(0).innerText()).trim();
    const brand = (await table.locator('td').count() > 2)
        ? (await table.locator('td').nth(2).innerText()).trim()
        : null;
    const cities = cityBlock.replace('csak személyes átvétel', '').replace('csomagküldéssel is', '').replace('aktív', '').replace('archivált', '').split(',').map(city => city.trim());
    const description = await page.locator('.mb-3.rtif-content').innerText();
    const carouselItems = await page.locator('.carousel-item').all();
    const imageSrcArrays = await Promise.all(
        carouselItems.map(async (item) => {
            const imgs = await item.locator('img').all();
            return Promise.all(imgs.map(async (img) => await img.getAttribute('src')));
        })
    );

    // Get all image URLs from the carousel items
    const flattenedImageUrls = imageSrcArrays.flat().filter((src): src is string => Boolean(src)).map(src => `https:${src}`);

    // Ensure images folder exists
    if (!fs.existsSync('images')) {
        fs.mkdirSync('images');
    }

    // Download images under the images folder
    const downloadedFiles = await Promise.all(
        flattenedImageUrls.map(async (url, index) => {
            const filename = `images/temp_image-${index}.jpg`;
            await downloadImage(url, filename);
            return filename;
        })
    );

    // Go to ad creation page
    await page.goto(newAdPageUrl, { waitUntil: 'networkidle' });

    // Clear any previously uploaded images
    await clearUploadedImages(page);

    // Fill ad title
    await page.locator('input[name="title"]').fill(title);

    // Upload images
    await downloadedFiles.reduce((promise, image) => {
        return promise.then(async () => {
            await page.setInputFiles('input.dz-hidden-input', image);
            await page.waitForTimeout(300);
        });
    }, Promise.resolve());

    // If there are too many images (this can happen if the copied ad is paid and has more than 5 images), exit the script
    if (await page.locator('text=Egy hirdetéshez maximum 5 db kép tölthető fel!').isVisible()) {
        console.error('Too many images. Please remove some images from the ad.');
        await browser.close();
        process.exit(1);
    }

    // Fill ad description
    await page.locator('.mce-content-body').fill(description);

    // Fill ad price
    if (price === 'Keresem') {
        await page.locator('div.form-check.form-check-inline').filter({ hasText: 'Keresem' }).click();
    } else if (price === 'Csere') {
        await page.locator('div.form-check.form-check-inline').filter({ hasText: 'Csak csere' }).click();
    } else if (price === 'Ingyenes') {
        await page.locator('div.form-check.form-check-inline').filter({ hasText: 'Ingyenes' }).click();
    } else {
        await page.locator('input[name="price"]').fill(price);
    }

    // Select ad category
    await categoryList.reduce((promise, category) => {
        return promise.then(async () => {
            await page.getByRole('button', { name: category, exact: true }).click()
            await page.waitForTimeout(200);
        });
    }, Promise.resolve());

    // Select ad place
    await cities.reduce((promise, city, index) => {
        return promise.then(async () => {
            const input = page.locator('input.token-adder.tt-input');
            await input.fill(city);
            await page.waitForTimeout(200);
            await page.locator(`.tt-suggestion:text-is("${city.trim()}")`).click();

            if (index === cities.length - 1) {
                await input.press('Escape');
            }
        });
    }, Promise.resolve());

    // Select if ad is not only in person
    if (!isOnlyInPerson) {
        await page.locator('div.form-check.form-check-inline').filter({ hasText: ' csomagküldéssel is' }).click();
    }

    // Fill ad condition
    if (condition === 'új') {
        await page.getByRole('radio', { name: 'Új' }).click({ force: true });
    }

    // Fill ad brand
    if (brand) {
        await page.locator('input.form-control.tt-input').fill(brand);
    }

    await page.evaluate(() => {
        const udridValue = (document.querySelector('input[name="udrid"]') as HTMLInputElement)?.value;

        const cmpidInputs = Array.from(document.querySelectorAll('input[name="cmpid"]')) as HTMLInputElement[];

        if (udridValue && cmpidInputs.length) {
            cmpidInputs.forEach(el => el.value = udridValue);
        }
    });

    await page.waitForTimeout(5000);

    // Wait for the response after submitting the ad
    const [response] = await Promise.all([
        page.waitForResponse(resp =>
            resp.url().includes('/muvelet/apro/uj.php') && resp.request().method() === 'POST'
        ),
        // Submit the ad
        page.getByRole('button', { name: 'Feladom a hirdetést!' }).click()
    ]);

    const status = response.status();
    if (status === 200) {
        console.log('✅ Upload succeeded!');
    } else if (status === 500) {
        console.log('❌ Server error (500)');
    }
    process.exit(0);

}

const clearUploadedImages = async (page: Page) => {
    const removeButtons = await page.locator('a.dz-remove').elementHandles();
    await Promise.all(
        removeButtons.map((handle, _) =>
            page.waitForTimeout(1000).then(() => handle.click())
        )
    );
};

const getRidOfCookiePopup = async (page: Page) => {
    //if cookies consent is available, click on "NEM FOGADOM EL" button
    if (await page.locator('.qc-cmp2-consent-info').isVisible()) {
        await page.getByText('NEM FOGADOM EL').first().click();
    }
}

const login = async (page: Page) => {
    await page.locator('input[type="email"]').fill(process.env.EMAIL || '');
    await page.locator('input[type="password"]').fill(process.env.PASSWORD || '');
    await Promise.all([
        page.getByRole('button', { name: 'Belépés' }).click(),
        page.getByText('Új hirdetés feladása').waitFor()
    ]);
}

if (!args[0]) {
    console.error('Please provide an url as an argument.\nUsage: npm run start -- "https://hardverapro.hu/apro/lejart_termek/friss.html"');
    process.exit(1);
}

if (!await isLoggedIn(onePage)) {
    console.log('You are not logged in. Logging in...');
    await login(onePage);
    if (!await isLoggedIn(onePage)) {
        console.error('Login failed. Please check your credentials.');
        await browser.close();
        process.exit(1);
    }
}

// Delete all images in the images folder
await fsPromises.rm('images', { recursive: true, force: true });

run(args[0], onePage);
