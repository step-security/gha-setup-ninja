const core = require('@actions/core')
const process = require('process')
const { validateSubscription } = require('./subscription')
const spawn = require('child_process').spawnSync
const path = require('path')
const fs = require('fs')
const URL = require('url').URL
const { https } = require('follow-redirects')
const AdmZip = require('adm-zip')
const HttpsProxyAgent = require('https-proxy-agent')

function selectPlatform(platform, version) {
    if (platform) {
        return [null, platform]
    }

    let [major, minor, patch] = version.split('.').map((s) => parseInt(s))
    if (process.platform === 'win32') {
        if (process.arch === 'arm64') {
            if (major < 1 || major === 1 && minor < 12) {
                return [new Error(`Windows ARM builds are only available for 1.12.0 and later`), '']
            }
            else {
                return [null, 'winarm64']
            }
        }
        else if (process.arch === 'x64') {
            return [null, 'win']
        }
        else {
            return [new Error(`Unsupported architecture '${process.arch}'`), '']
        }
    }
    else if (process.platform === 'linux') {
        if (process.arch === 'arm64') {
            if (major < 1 || major === 1 && minor < 12) {
                return [new Error(`Linux ARM builds are only available for 1.12.0 and later`), '']
            }
            else {
                return [null, 'linux-aarch64']
            }
        }
        else if (process.arch === 'x64') {
            return [null, 'linux']
        }
        else {
            return [new Error(`Unsupported architecture '${process.arch}'`), '']
        }
    }
    else if (process.platform === 'darwin') {
        return [null, 'mac']
    }
    else {
        return [new Error(`Unsupported platform '${process.platform}'`), '']
    }
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/
const ALLOWED_PLATFORMS = ['win', 'winarm64', 'linux', 'linux-aarch64', 'mac']

async function run() {
try {
    await validateSubscription();
    const version = core.getInput('version', {required: true})
    if (!SEMVER_RE.test(version)) {
        throw new Error(`Invalid version format '${version}'. Expected semver (e.g. 1.11.1)`)
    }

    const destDir = core.getInput('destination') || 'ninja-build'
    const proxyServer = core.getInput('http_proxy')

    const userPlatform = core.getInput('platform')
    if (userPlatform && !ALLOWED_PLATFORMS.includes(userPlatform)) {
        throw new Error(`Invalid platform '${userPlatform}'. Allowed: ${ALLOWED_PLATFORMS.join(', ')}`)
    }

    const [error, platform] = selectPlatform(userPlatform, version)
    if (error) throw error

    const url = new URL(`https://github.com/ninja-build/ninja/releases/download/v${version}/ninja-${platform}.zip`)

    if (proxyServer) {
        try {
            const proxyUrl = new URL(proxyServer)
            if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
                throw new Error('Proxy URL must use http or https protocol')
            }
        } catch (e) {
            throw new Error(`Invalid proxy URL '${proxyServer}': ${e.message}`)
        }
        console.log(`using proxy ${proxyServer}`)
        url.agent = new HttpsProxyAgent(proxyServer)
    }

    console.log(`downloading ${url}`)
    await new Promise((resolve, reject) => {
        const request = https.get(url, {followAllRedirects: true}, result => {
            const data = []

            result.on('data', chunk => data.push(chunk))

            result.on('end', () => {
                try {
                    const length = data.reduce((len, chunk) => len + chunk.length, 0)
                    const buffer = Buffer.alloc(length)

                    data.reduce((pos, chunk) => {
                        chunk.copy(buffer, pos)
                        return pos + chunk.length
                    }, 0)

                    const zip = new AdmZip(buffer)
                    const entries = zip.getEntries()
                    if (entries.length === 0) throw new Error('ZIP archive is empty')
                    const entry = entries[0]
                    const ninjaName = entry.entryName

                    if (ninjaName.includes('..') || path.isAbsolute(ninjaName) || ninjaName.includes('/') || ninjaName.includes('\\')) {
                        throw new Error(`Unsafe entry name in ZIP: '${ninjaName}'`)
                    }

                    const fullDestDir = path.resolve(process.cwd(), destDir)
                    if (!fs.existsSync(fullDestDir)) fs.mkdirSync(fullDestDir, {recursive: true})

                    const fullFileDir = path.join(fullDestDir, ninjaName)
                    const resolvedDest = path.resolve(fullFileDir)
                    if (!resolvedDest.startsWith(fullDestDir + path.sep) && resolvedDest !== fullDestDir) {
                        throw new Error(`ZIP entry would extract outside destination: '${ninjaName}'`)
                    }

                    zip.extractEntryTo(ninjaName, fullDestDir, /*maintainEntryPath*/false, /*overwrite*/true)
                    if (!fs.existsSync(fullFileDir)) throw new Error(`failed to extract to '${fullFileDir}'`)

                    fs.chmodSync(fullFileDir, '755')

                    console.log(`extracted '${ninjaName}' to '${fullFileDir}'`)

                    core.addPath(fullDestDir)
                    console.log(`added '${fullDestDir}' to PATH`)

                    const result = spawn(ninjaName, ['--version'], {encoding: 'utf8'})
                    if (result.error) throw result.error

                    const installedVersion = result.stdout.trim()

                    console.log(`$ ${ninjaName} --version`)
                    console.log(installedVersion)

                    if (installedVersion !== version) {
                        throw new Error('incorrect version detected (bad PATH configuration?)')
                    }

                    resolve()
                } catch (e) {
                    reject(e)
                }
            })

            result.on('error', reject)
        })
        request.on('error', reject)
    })
} catch (error) {
    core.setFailed(error.message)
}
}

run()
