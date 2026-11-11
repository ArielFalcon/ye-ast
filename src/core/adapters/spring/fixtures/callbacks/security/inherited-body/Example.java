package app;
import org.springframework.stereotype.Service;
import org.springframework.security.core.userdetails.UserDetailsService;
abstract class Base implements UserDetailsService { public Object loadUserByUsername(String s) { return null; } }
@Service class First extends Base {}
@Service class Second extends Base {}
