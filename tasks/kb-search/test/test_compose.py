"""Validate only this local prototype; no daemon or existing release is modified."""
import json
from pathlib import Path
import subprocess
import unittest

APP = Path(__file__).resolve().parents[1]


class ComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(subprocess.check_output([
            'docker', 'compose', '--env-file', str(APP / '.env.example'),
            '-f', str(APP / 'compose.yml'), 'config', '--format', 'json'], text=True, encoding='utf-8'))

    def test_exactly_two_independent_containers(self):
        services = self.config['services']
        self.assertEqual(set(services), {'search-reflected', 'search-dom'})
        self.assertEqual(set(services['search-reflected']['networks']), {'reflected_net'})
        self.assertEqual(set(services['search-dom']['networks']), {'dom_net'})
        self.assertFalse(self.config.get('volumes'))
        for network in self.config['networks'].values():
            self.assertTrue(network['internal'])
            self.assertFalse(network['enable_ipv6'])
            self.assertFalse(network.get('external'))

    def test_loopback_ports_and_separate_demo_values(self):
        services = self.config['services']
        ports = []
        for service in services.values():
            self.assertEqual(len(service['ports']), 1)
            port = service['ports'][0]
            self.assertEqual(port['host_ip'], '127.0.0.1')
            self.assertEqual(port['target'], 8080)
            ports.append(port['published'])
        self.assertEqual(len(set(ports)), 2)
        left, right = (services[n]['environment'] for n in ('search-reflected', 'search-dom'))
        for key in ('COOKIE_NAME', 'SESSION_SECRET', 'DEMO_LOGIN_CODE', 'DEMO_FLAG'):
            self.assertNotEqual(left[key], right[key])
        for env in (left, right):
            self.assertTrue(env['DEMO_FLAG'].startswith('KB2CTF{demo_'))
            self.assertNotEqual(env['SESSION_SECRET'], env['DEMO_LOGIN_CODE'])

    def test_limits_and_browser_sandbox(self):
        for service in self.config['services'].values():
            self.assertEqual(service['user'], '10001:10001')
            self.assertTrue(service['read_only'])
            self.assertEqual(service['cap_drop'], ['ALL'])
            self.assertIn('no-new-privileges:true', service['security_opt'])
            self.assertFalse(any('unconfined' in option for option in service['security_opt']))
            self.assertEqual(int(service['mem_limit']), 768 * 1024**2)
            self.assertEqual(int(service['memswap_limit']), 1024 * 1024**2)
            self.assertEqual(service['pids_limit'], 256)
            self.assertEqual(service['cpus'], 1)
            self.assertFalse(service.get('volumes'))
            self.assertNotIn('host', service.get('network_mode', ''))
            self.assertTrue(all(flag in service['tmpfs'][0] for flag in ('noexec', 'nosuid', 'nodev', 'size=')))


if __name__ == '__main__':
    unittest.main()
