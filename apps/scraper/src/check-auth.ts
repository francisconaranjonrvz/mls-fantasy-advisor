/**
 * Dice que metodos de acceso admite una cuenta de Mister.
 *
 * Mister expone este dato en un endpoint publico y sin autenticacion, asi que
 * responde en un segundo y sin efectos secundarios la unica pregunta que decide
 * como se configura todo lo demas: hace falta capturar la sesion del navegador,
 * o basta con email y contrasena?
 *
 *   pnpm check:auth tu-email@ejemplo.com
 */

const ENDPOINT = 'https://mister.mundodeportivo.com/api2/users/auth-methods'

interface AuthMethodsResponse {
  supportedAuthMethods?: string[]
}

const LABELS: Record<string, string> = {
  email: 'email y contrasena',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim()

  if (!email || !email.includes('@')) {
    console.error('Uso: pnpm check:auth tu-email@ejemplo.com')
    console.error('')
    console.error('Tiene que ser el email de tu cuenta de MISTER. Si entras con Google,')
    console.error('normalmente es el mismo de tu cuenta de Google.')
    process.exitCode = 1
    return
  }

  const res = await fetch(`${ENDPOINT}?email=${encodeURIComponent(email)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
  })

  if (res.status === 404) {
    console.log('')
    console.log('Ese email no esta registrado en Mister.')
    console.log('Comprueba cual usas para entrar; si entras con Google, sera el de esa cuenta.')
    process.exitCode = 1
    return
  }

  if (!res.ok) {
    console.error(`Mister respondio ${res.status}. Cuerpo: ${(await res.text()).slice(0, 200)}`)
    process.exitCode = 1
    return
  }

  const methods = ((await res.json()) as AuthMethodsResponse).supportedAuthMethods ?? []
  const soportaEmail = methods.includes('email')

  console.log('')
  console.log(`Metodos de acceso de esa cuenta: ${methods.map((m) => LABELS[m] ?? m).join(', ') || 'ninguno'}`)
  console.log('')

  if (soportaEmail) {
    console.log('Tu cuenta ADMITE contrasena. Es la via mas simple, y no caduca nunca:')
    console.log('')
    console.log('  1. En la pantalla de acceso de Mister, pulsa "Recuperar contrasena".')
    console.log('  2. Fija una contrasena desde el correo que recibas.')
    console.log('  3. Guardala en los secrets MISTER_EMAIL y MISTER_PASSWORD.')
    console.log('')
    console.log('No hace falta capturar ninguna sesion.')
  } else {
    console.log('Tu cuenta NO admite contrasena: solo se puede entrar por OAuth.')
    console.log('')
    console.log('  1. pnpm --filter @mls/scraper exec playwright install chromium')
    console.log('  2. pnpm capture:session')
    console.log('  3. Pega el valor que imprime en el secret MISTER_SESSION.')
  }
}

main().catch((err) => {
  console.error('No se pudo consultar:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
