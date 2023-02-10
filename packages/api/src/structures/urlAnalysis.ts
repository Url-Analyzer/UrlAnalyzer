import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:dns/promises';
import { URL } from 'node:url';
import { createCertificateDetails } from '@database/certificate_details/createCertDetails.js';
import { getCertificateDetails } from '@database/certificate_details/getCertDetails.js';
import { createRequest } from '@database/requests/createRequest.js';
import { getRequestsByParentId } from '@database/requests/getRequest.js';
import { createResponse } from '@database/responses/createResponse.js';
import { getResponsesByParentId } from '@database/responses/getResponse.js';
import { createUrlAnalysis } from '@database/scans/createScan.js';
import type Imgur from '@functions/services/Imgur.js';
import { checkUrlSafeBrowsing, checkUrlTransparencyReport } from '@functions/services/SafeBrowsing.js';
import type { PopulatedRequest, RawCertificate, RawResponse, RawUrlAnalysis } from '@types';
import { convertCert, parseInfoAccess, parseIssuer, parseSubject, parseSubjectAltName } from '@utils/certUtils.js';
import { formatHTTPRequest, formatHTTPResponse } from '@utils/formatReq.js';
import { generateCompoundSnowflake, generateSnowflake } from '@utils/idUtils.js';
import { allowedResourceTypes, REGEXES, TableWorkerIdentifiers } from 'constants.js';
import lighthouse from 'lighthouse';
import getMetaData from 'metadata-scraper';
import type { Page, Protocol, Browser, CDPSession, HTTPResponse, HTTPRequest } from 'puppeteer';
import { kCache, kImgur, kPuppeteer } from 'tokens.js';
import { container } from 'tsyringe';
import type { ConsoleOutput, InternalCache, Screenshot, UrlAnalysisResult, UrlSecurityDetails } from 'types/types.js';

export default class UrlAnalysis {
	public browser: Browser;

	public url: string;

	public page: Page | null = null;

	public requests: PopulatedRequest[];

	public cookies: Protocol.Network.Cookie[];

	public consoleOutput: ConsoleOutput[];

	public contactedDomains: Set<string>;

	public urlsFound: string[];

	public body: string | null = null;

	public effectiveUrl: string | null = null;

	public dns: Record<string, string[]> | null = null;

	public screenshotUrl: Screenshot | null = null;

	public certificate: RawCertificate | null = null;

	public metadata: Record<string, unknown> | null = null;

	public security: UrlSecurityDetails | null = null;

	private readonly _promises: Promise<any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

	private _imgurClient = container.resolve<Imgur>(kImgur);

	public certificate_id: string | null = null;

	public created_at: string | null = null;

	public updated_at: string | null = null;

	public id: string;

	public requests_ids: string[] = [];

	private dbResult: RawUrlAnalysis | null = null;

	public constructor(url: string) {
		this.browser = container.resolve<Browser>(kPuppeteer);

		this.id = generateSnowflake(TableWorkerIdentifiers.Scan);

		this.url = url;

		this.requests = [];
		this.cookies = [];
		this.consoleOutput = [];

		this.contactedDomains = new Set();

		this.urlsFound = [];

		this._promises = [];
	}

	public async navigate() {
		const cache = container.resolve<InternalCache>(kCache);

		try {
			this.page = await this.browser.newPage();

			await this.page.setRequestInterception(true);
			this.registerListeners();

			const client = await this.page.target().createCDPSession();
			await client.send('Network.enable');

			const pageResponse = await this.page.goto(this.url, { waitUntil: 'networkidle2' });

			this.effectiveUrl = this.page.url();

			const [body, cookies] = await Promise.all([
				this.page.content(),
				this.page.cookies(),
				this.screenshot(),
				this.resolveDns(),
				this.getCertificate(client, pageResponse!),
				this.securityDetails(),
				this.lightHouse(),
			]);

			this.body = body;
			this.cookies = cookies;
			await this.processBody();

			const result = await this.finish();
			cache.set(this.id, {
				ok: true,
				data: result,
				added: Date.now(),
			});
		} catch (error) {
			console.error(error);
			await this.page?.close();

			cache.set(this.id, {
				ok: false,
				error: (error as Error).message,
				added: Date.now(),
			});
		}
	}

	public async lightHouse() {
		return lighthouse(this.url, {
			port: Number(new URL(this.browser.wsEndpoint()).port),
			output: 'json',
			logLevel: 'error',
		}).then((result) => {
			const lighthouseResult = result!.lhr;
			console.log('Report', lighthouseResult);
			console.log('Report is done for', lighthouseResult.mainDocumentUrl);
			console.log('Cat analyzed', Object.keys(lighthouseResult.categories));
			console.log('Score was', lighthouseResult.categories);
		});
	}

	public async screenshot() {
		const buffer = await this.page?.screenshot({
			fullPage: true,
			quality: 100,
			type: 'jpeg',
		});

		if (!buffer) return;

		this.screenshotUrl = await this._imgurClient
			.uploadImage({
				data: buffer,
				type: 'public',
				url: this.url,
			})
			.catch(() => null);
	}

	public async getCertificate(client: CDPSession, res: HTTPResponse) {
		if (!this.page) return;

		const rawSecurityDetails = res.securityDetails();

		const parsedSecurityDetails = {
			issuer: rawSecurityDetails?.issuer() ?? 'Unknown',
			protocol: rawSecurityDetails?.protocol() ?? 'Unknown',
			subjectName: rawSecurityDetails?.subjectName() ?? 'Unknown',
			validFrom: rawSecurityDetails?.validFrom() ?? 0,
			validTo: rawSecurityDetails?.validTo() ?? 0,
		};

		const certificate = await client.send('Network.getCertificate', {
			origin: this.page.url(),
		});

		const parsedCertificate = certificate.tableNames.map((name) => {
			const decoded = convertCert(name);

			const x509 = new X509Certificate(decoded);

			return {
				encoded: name,
				decoded,
				x509: {
					ca: x509.ca,
					fingerprint: x509.fingerprint,
					fingerprint256: x509.fingerprint256,
					fingerprint512: x509.fingerprint512,
					infoAccess: parseInfoAccess(x509.infoAccess),
					issuer: parseIssuer(x509.issuer),
					subject: parseSubject(x509.subject),
					subjectAltName: parseSubjectAltName(x509.subjectAltName),
					keyUsage: x509.keyUsage,
					serialNumber: x509.serialNumber,
					validFrom: new Date(x509.validFrom).toISOString(),
					validTo: new Date(x509.validTo).toISOString(),
				},
			};
		});

		this.certificate = await createCertificateDetails({
			id: this.id,
			parent_id: this.id,
			certificates: parsedCertificate,
			subject_name: parsedSecurityDetails.subjectName,
			valid_to: parsedSecurityDetails.validTo,
			valid_from: parsedSecurityDetails.validFrom,
			...parsedSecurityDetails,
		});

		this.certificate_id = this.certificate.id;
	}

	public async resolveDns() {
		const domains = [...this.contactedDomains].filter((domain) => domain.length);

		const resolvedDomains: Record<string, string[]> = {};

		for (const domain of domains) {
			try {
				resolvedDomains[domain] = await resolve(domain);
			} catch {
				resolvedDomains[domain] = [];
			}
		}

		this.dns = resolvedDomains;
	}

	public registerListeners() {
		if (!this.page) return;

		this.page.on('request', async (request) => {
			const hostname = new URL(request.url()).hostname;

			if (hostname.length) this.contactedDomains.add(hostname);

			const nonce = generateCompoundSnowflake(TableWorkerIdentifiers.ScanNonce, 3);

			// add nonce to the request headers
			const headers = request.headers();
			headers['x-url-analyzer-nonce'] = nonce;

			request.continue();
		});

		this.page.on('response', async (response) => {
			const request = await this.addAndResolvePromise(formatHTTPRequest(response.request()));
			request.response = await this.addAndResolvePromise(formatHTTPResponse(response));

			const resource_type_allowed = allowedResourceTypes.includes(
				request.resource_type as ReturnType<HTTPRequest['resourceType']>,
			);

			const dbResponse = await createResponse({
				...request.response,
				id: this.id,
				parent_id: this.id,
				body: resource_type_allowed ? request.response.body : null,
			});
			const dbRequest = await createRequest({
				...request,
				id: this.id,
				parent_id: this.id,
				response_id: dbResponse.id,
				nonce: request.headers['x-url-analyzer-nonce'] ?? null,
			});

			this.requests.push({
				...dbRequest,
				response: dbResponse,
			});
			this.requests_ids.push(dbRequest.id);
		});

		this.page.on('console', (message) => {
			this.consoleOutput.push({
				type: message.type(),
				text: message.text(),
				args: message.args(),
			});
		});
	}

	public async securityDetails() {
		if (!this.page) return;

		const [safeBrowsing, transparencyReport] = await Promise.all([
			checkUrlSafeBrowsing([this.url, this.effectiveUrl!]),
			checkUrlTransparencyReport(this.effectiveUrl!),
		]);

		this.security = {
			safeBrowsing,
			transparencyReport,
		};
	}

	public async processBody() {
		if (!this.body) return;

		// @ts-expect-error: This is callable
		this.metadata = await getMetaData({
			url: this.page?.url(),
			html: this.body,
		});

		const urls = Array.from(new Set(this.body.matchAll(REGEXES.URL)));

		this.urlsFound = urls.map((url) => url[0].replace(/["'>].+$/, ''));
	}

	public async finish(): Promise<UrlAnalysisResult> {
		if (this.dbResult) {
			return UrlAnalysis.createFromDbResult(this.dbResult, {
				certificate: this.certificate!,
				requests: this.requests,
			});
		}

		await Promise.all([this.page!.close(), ...this._promises]);

		const dbResult = await createUrlAnalysis({
			url: this.url,
			effective_url: this.effectiveUrl!,
			screenshot: this.screenshotUrl,
			metadata: this.metadata!,
			cookies: this.cookies,
			console_output: this.consoleOutput,
			contacted_domains: Array.from(this.contactedDomains.values()),
			urls_found: this.urlsFound,
			body: this.body!,
			dns: this.dns!,
			security_details: this.security!,
			certificate_id: this.certificate_id!,
			id: this.id,
			requests_ids: this.requests_ids,
		});

		this.dbResult = dbResult;

		return UrlAnalysis.createFromDbResult(this.dbResult!, {
			certificate: this.certificate!,
			requests: this.requests,
		});
	}

	private async addAndResolvePromise<T>(promise: Promise<T>) {
		this._promises.push(promise);

		return promise;
	}

	public static async createFromDbResult(
		dbResult: RawUrlAnalysis,
		extras?: {
			certificate?: RawCertificate;
			requests?: PopulatedRequest[];
		},
	): Promise<UrlAnalysisResult> {
		const result: RawUrlAnalysis & {
			certificate?: RawCertificate;
			requests?: PopulatedRequest[];
		} = dbResult;

		if (extras?.requests?.length) {
			result.requests = extras.requests;
		} else {
			const requests: PopulatedRequest[] = (await getRequestsByParentId(dbResult.id)) as unknown as PopulatedRequest[];
			const responses: RawResponse[] = await getResponsesByParentId(dbResult.id);

			for (const request of requests) {
				const response = responses.find((res) => res.id === request.response_id);

				request.response = response ?? null;
			}

			result.requests = requests;
		}

		if (extras?.certificate) {
			result.certificate = extras.certificate;
		} else {
			result.certificate = await getCertificateDetails(dbResult.certificate_id);
		}

		return {
			...result,
			contactedDomains: result.contacted_domains,
			consoleOutput: result.console_output,
			effectiveUrl: result.effective_url,
			securityDetails: result.security_details,
			urlsFound: result.urls_found,
			certificate: result.certificate!,
			requests: result.requests!,
		};
	}
}